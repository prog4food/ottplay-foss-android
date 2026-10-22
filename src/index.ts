import { popupActionId } from "./compatibility/legacy-names";
import { installStandby } from "./core/standby";
import { applyLanguageMetadata, normalizeSearchText } from "./localization";
import {
    languageAssetPath,
    languageLocaleTag,
    languageNames,
} from "./localization/assets";
import { accessMediaPlugin, prepareAccessMedia } from "./plugins/access-media";
import { installLocalMedia } from "./plugins/local-media";
import { createSettingsEditor } from "./settings/editor";
import {
    editSettingsText,
    exportSettingsUI,
    importSettingsUI,
} from "./settings/transfer-ui";
import { showSettingsRecovery } from "./storage/recovery-ui";
import {
    hasTmdbService,
    listPreviewRect,
    metadataCssUrl,
    metadataText,
} from "./utils/helpers";
/**
 * OTT-play FOSS — main entry point.
 * Wires all modules together and exposes globals for backward compat.
 *
 * Responsibilities:
 * - Initialize storage, UI, and STB emulation layer.
 * - Load language files and provider scripts.
 * - Provide the settings subsystem (stbOptions, settingsInterface, etc.).
 * - Publish the legacy provider/device interface on window.*.
 * - Handle playback (channel and media), channel list display, archive mode.
 * - Manage sleep timers, info bar, PiP, preview, and cloud settings sync.
 *
 * Build contract: TypeScript emits ES5 modules; the classic linker removes
 * module syntax and combines them in dependency order. Top-level declarations
 * remain public in legacy modules because separately loaded device/provider
 * scripts use them. Audited private modules expose only an explicit window API.
 * The optimizer preserves those bindings, property names and function names
 * (menu preferences persist callback.name). Only compiler-generated helpers
 * with identical verified implementations are shared by the linker.
 * TypeScript does not tree-shake implementations. Remove or move a function
 * only after checking its runtime callers and the classic global contract.
 */

// Polyfills (must run first)
import "./polyfills";

import {
    createCommandServer,
    createCommandServerTransport,
    normalizeCommandServerAddress,
} from "./plugins/command-server";
import { createControlDiscovery } from "./plugins/control-discovery";
import { installDiagnosticsController } from "./plugins/diagnostics-controller";
import { nativePromiseToJq } from "./plugins/jquery-bridge";
import { createLocalHttpRemote } from "./plugins/local-http-remote";
import { setupCapacitorCompanionShim } from "./plugins/m3u-proxy";
import { MobileNativeMedia } from "./plugins/mobile-native-media";
import { resolveNativePlugin, tauriInvoke } from "./plugins/native-bridge";
import { installRemoteLifecycle } from "./plugins/remote-lifecycle";
import { installRemoteScreenshot } from "./plugins/remote-screenshot";
import { installRuntimeDebug } from "./plugins/runtime-debug";
import "./plugins/native-http";
import {
    StalkerPortal,
    setupStalkerPortalShim,
} from "./plugins/stalker-portal";

// Utils
import * as encoding from "./utils/encoding";

// lzstring functions from utils/lzstring.ts (loaded earlier in concat)
declare const compress: any;

// Channels — only import what actually exists
import {
    _enterPinCode,
    _prog100,
    _tmedia,
    aAspects,
    aAudios,
    addFavoritesList,
    addToFavorites,
    applyChannelTvgShift,
    aSubs,
    aZooms,
    bucketsList,
    captureChannelPreference,
    catIndex,
    cats,
    catsArray,
    channels,
    channelsList,
    curList,
    deleteFavoritesList,
    detailEPG,
    enterPinAndSetAccess,
    enterPinCode,
    epg,
    epg_ch_id,
    epgArchiveHours,
    epgArray,
    epgKeyHandler,
    epgList,
    epgListAlpha,
    epgListMode,
    epgreturn,
    epgTimezoneHours,
    favoritesArray,
    fetchChannelGuide,
    fileArchive,
    getActiveFavoritesListName,
    getChannelEpgCached,
    getChannelUrl,
    getMediaDescr,
    handleNumberInput,
    ifParentalAccessChId,
    invalidateEpgCache,
    itemEPG,
    listEpgArray,
    listFavoritesLists,
    loadEpgListData,
    type MediaHistoryEntry,
    medFavorites,
    medHistory,
    mediaSelects,
    mediaUrls,
    nextChannel,
    observeCurrentProgramme,
    parentalArray,
    parentControlSetup,
    playArchive,
    playTime,
    playType,
    popFavLists,
    prevArr,
    prevChannel,
    primaryIndex,
    publishChannelProgrammeRows,
    publishGuideReminders,
    recordsList,
    removeFromFavorites,
    renameFavoritesList,
    renderCategoryRecordings,
    renderEpgFooter,
    renderGuideView,
    replayFromLiveOffset,
    saveChannelsCats,
    selectEpg,
    setActiveFavoritesList,
    setCurrent,
    setEpgTimer,
    setParentAccess,
    shiftArchive,
    showPlaybackSeekDialog,
    updateArchiveInfo,
} from "./channels";
// Localization
import { _, translate, translations, useGraphicIcons } from "./localization";
// Settings
import {
    applyTimezoneSetting,
    beginSettingsDraft,
    defaultSettings,
    exportSettings,
    importSettings,
    installSettingsFacade,
    loadSettings,
    normalizeSeekDuration,
    type PlayerSettings,
    saveSettings,
    settings,
} from "./settings";
import { cloudLoadSettings, cloudSendSettings } from "./settings/cloud";
import { setSleepTimeout } from "./settings/sleep-timer";
// Storage
import {
    getMacAddress,
    providerDelItem,
    providerGetItem,
    providerGetJson,
    providerGetNum,
    providerHasItem,
    providerHasItemValue,
    providerSetItem,
    setProviderPrefix,
    stbClearAllItems,
    stbDelItem,
    stbGetAllItems,
    stbGetItem,
    stbGetPersistedItem,
    stbSetItem,
    storage,
} from "./storage";
import { queueFeedbackPost, sendClientFeedback } from "./utils/helpers";

// Publish the canonical channel map; the compatibility module links legacy access.
(window as any).channels = channels;

// Core
import {
    bufferSizes,
    captureAspectTarget,
    loadAllOptions,
    playerMode,
    playerModeNames,
    saveAllOptions,
    setPipPosition,
    setPlayer,
    setPlayerMode,
    stbAudioTracksExists,
    stbContinue,
    stbCSS,
    stbExit,
    stbGetLen,
    stbGetPosTime,
    stbGetVolume,
    stbInfo,
    stbInit,
    stbIsPlaying,
    stbIsStandby,
    stbPause,
    stbPlay,
    stbPlayPip,
    stbResume,
    stbSetBuffer,
    stbSetPosTime,
    stbSetStandby,
    stbSetVolume,
    stbSetWindow,
    stbStop,
    stbStopPip,
    stbSubtitleExists,
    stbToFullScreen,
    stbToggleAspectRatio,
    stbToggleAudioTrack,
    stbToggleMute,
    stbToggleStandby,
    stbToggleSubtitle,
    stbToggleZoom,
    strAspect,
    strAudio,
    strENTER,
    strEPG,
    strEXIT,
    strInfo,
    strLANG,
    strPip,
    strPRECH,
    strRETURN,
    strSETUP,
    strTools,
    strZoom,
    toggleAspectRatio,
    toggleAudioTrack,
    toggleSubtitle,
    toggleZoom,
    video,
    videoPip,
} from "./core";

// UI — popup functions
import {
    backColorDialog,
    changeSelect,
    closeList,
    colorDialog,
    confirmBox,
    editKey1,
    editKey2,
    exitPortal,
    formatSeekOffset,
    hideInfoBarWhenReady,
    hsvToRgb,
    infoBarHide,
    infoBox,
    infoList,
    initBackgroundIntervals,
    playPipChannel,
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
    popupList,
    refreshAudioBadge,
    renderButtonHint,
    restoreListPanelState,
    saveListPanelState,
    selColorDialog,
    setSelect,
    showChannelInfo,
    showEditKey1,
    showEditKey2,
    showPage,
    showProgramInfo,
    showSelectBox,
    showShift,
    strDOWN,
    strFF,
    strLEFT,
    strNEXT,
    strNew,
    strPAUSE,
    strPLAY,
    strPlayPause,
    strPREV,
    strRIGHT,
    strRW,
    strSTOP,
    strSubt,
    strUP,
    uiInit,
    updateChannelInfo,
    updateMediaInfo,
} from "./ui";

// jQuery (loaded externally via <script> tag)
declare var $: any;

// Command handler (push commands via webhook)
import { type Command, handleCommand, showPopup } from "./commands";
import { executeRemoteRequest } from "./commands/remote-requests";
import { remotePlayerInfo } from "./commands/remote-restart";
// Key handler
import {
    dispatchKey,
    keyHandler,
    keys,
    ottBandViewportHeight,
    ottBottomInfoBandStart,
} from "./key-handler";
import { createKiosk } from "./plugins/kiosk";
import { bindKioskScreen } from "./plugins/kiosk-screen";
import { installRemoteInspection } from "./plugins/remote-inspect";
// Provider — only import what actually exists
import {
    edit_dealer,
    edit_dealer_remote,
    isPlayDistribution,
    loadChannels,
    loadProv,
    optionsList,
    restart,
    showProviderSelection,
    toggleProviderSelectionVisibility,
    toggleProviderSettingsVisibility,
} from "./provider";

// duneAddSettings — initially null, set by provider scripts
declare var duneAddSettings: ((_index: number) => void) | null;

// noop — no-op callback used by firstRun list
/** A no-op function used as a placeholder callback in list entries and popup menus. */
function noop(): void {}

// Version
var PLAYER_VERSION = "__OTTP_VERSION__";

// Backward compat globals (were defined in old monolithic bundle)
// channelListItemWidth — channel list item width, updated by showPage()
(window as any).channelListItemWidth = 735;
// Capability probes must tolerate privacy-restricted native storage access.
function hasReadableLocalStorage(): boolean {
    try {
        var nativeStorage = window.localStorage;
        if (!nativeStorage) return false;
        nativeStorage.getItem("");
        return true;
    } catch (_storageAccess) {
        return false;
    }
}

// client_can — capability detection for provider scripts
(window as any).client_can_https = false;
(window as any).client_can = {
    https: (window as any).client_can_https,
    is_maple:
        typeof navigator !== "undefined" &&
        navigator.userAgent.indexOf("Maple 6") !== -1,
    localstorage: hasReadableLocalStorage(),
    websocket: typeof window.WebSocket !== "undefined",
};
(window as any).client_can.crossxhr =
    typeof navigator !== "undefined" &&
    !/(?:Viera\/1\.)/.test(navigator.userAgent);

// Host URL
var hostUrl = "";

// Device type
var deviceType = "";

// EPG domain
var epgDomain = "";

// Parental PIN
declare var parentPIN: string;

// Hide menus list
var hideMenus: string[] = [];

// Sleep timer — now in src/settings/sleep-timer.ts (Phase C)
// Info timeout
var infoTimeout: any = null;

// Number input state
var numberBuffer = "";
var numberTimeout: any = null;

// List state
declare var isListVisible;
var listSelectionIndex = 0;
declare var listDataArray: any[];
declare var getListItemFn: Function | null;
declare var detailListActionFn: Function | null;
declare var listKeyHandlerFn: Function | null;
declare var selIndex;
declare var listArray: any[];

// Edit mode
var editValue = "";

// Select box

// PiP state
var pipIndex: number | null = null;
var pipCatIndex = 0;

// Preview
var previewChan: any = null;
var previewTimer: any = null;

// Provider codecs retain their array ABI; the registry owns built-in identities.
var initialMenu = (window as any).__ottMenuRegistry.defaults(window as any);
var popupActions: any[] = initialMenu.actions;
var popupArray: string[] = (window as any).popupArray || initialMenu.labels;
var popupDetail: any[] = (window as any).popupDetail || initialMenu.details;

var savedPopup: {
    ver: string;
    popupActions: any[];
    popupArray: string[];
    popupDetail: string[];
} = { popupActions: [], popupArray: [], popupDetail: [], ver: PLAYER_VERSION };
var version: string = PLAYER_VERSION;

// Options system (ported from stbPlayer.js)
var optionsArr: { action: any; name?: string; desc?: string }[] = [];

/**
 * Find the index of an action function within an array of { action } objects.
 *
 * @param arr - Array of objects with an `action` property.
 * @param action - The action function to locate.
 * @returns The index, or -1 if not found.
 */
function indexOfAction(arr: any[], action: any): number {
    for (var i = 0; i < arr.length; i++) if (arr[i].action === action) return i;
    return -1;
}

/**
 * Convenience wrapper: find the index of `action` in the global optionsArr.
 *
 * @param action - The action function to find.
 * @returns Index in optionsArr, or -1.
 */
function findOptionIndex(action: any): number {
    return indexOfAction(optionsArr, action);
}

/**
 * Remove an option entry from optionsArr by its action function.
 *
 * @param action - The action to remove. No-op if not found.
 * Side effects: Mutates optionsArr.
 */
function removeOption(action: any): void {
    var idx = findOptionIndex(action);
    if (idx > -1) optionsArr.splice(idx, 1);
}

/**
 * Prepend a styled button label to a list item whose action matches.
 * Used to overlay number/color button shortcuts onto settings list entries.
 *
 * @param arr - Array of { action } objects (e.g. optionsArr).
 * @param action - The action to target.
 * @param label - The button label HTML to prepend.
 *
 * Side effects: Mutates listArray (via global reference cast).
 * No-op if label is empty or action not found.
 */
function prependMenuButtonHint(arr: any[], action: any, label: string): void {
    if (!label) return;
    var idx = indexOfAction(arr, action);
    if (idx > -1)
        (listArray as any)[idx] =
            '<div class="btn">' + label + "</div> " + (listArray as any)[idx];
}

// Font family list (index: 0=system, 1=Roboto, 2=RobotoCondensed, 3=Caveat, 4=Liberation, 5=Gabriela, 6=PTSansNarrow)
var fontFamilyList = (window as any).__ottNativeFontFamilies || [
    "",
    "Roboto, ",
    "RobotoCondensed, ",
    "Caveat, ",
    "Liberation, ",
    "Gabriela, ",
    "PTSansNarrow, ",
];

// Color state — defaults from original stbPlayer.js
var curColor = "gold";
var curColorB = "#668";
var bodyColor = "#f0f0f0";

// Page size
var pageSize = 25;

// TMDb — FOSS uses companion `/tmdb/s/*` (API key injected server-side).
// Mode B embed routes those URLs through setupTauriCompanionShim → tmdb_proxy.
// Poster/backdrop images use the public image CDN (img tags; no CORS proxy needed).
var TMDb: any = {
    apiPath: function (tail: string): string {
        const h = String((window as any).host || "");
        const path = "/tmdb/s/" + String(tail || "").replace(/^\//, "");
        if (h && h !== "-" && /^https?:\/\//i.test(h)) {
            return h.replace(/\/$/, "") + path;
        }
        return path;
    },
    data: null as any,
    fun: "css",
    get: function (media_type: string, id: any) {
        if (!hasTmdbService()) return;
        const $ = (window as any).$;
        const _ =
            (window as any)._ ||
            function (s: string) {
                return s;
            };
        const getViewportHeightScale =
            (window as any).getViewportHeightScale ||
            function () {
                return 1;
            };
        const api_lang = TMDb.locale();
        function renderMediaDescription(item: any): string {
            function it(val: any, title?: string): string {
                return val
                    ? (title ? "<b>" + _(title) + ": </b>" : "") +
                          metadataText(val) +
                          "<br>"
                    : "";
            }
            const genre: string[] = [];
            const country: string[] = [];
            const actors: string[] = [];
            const director: string[] = [];
            const script: string[] = [];
            if (item.genres) {
                item.genres.forEach(function (val: any) {
                    genre.push(val.name);
                });
            }
            if (item.production_countries) {
                item.production_countries.forEach(function (val: any) {
                    country.push(val.name);
                });
            }
            if (item.credits && item.credits.cast) {
                item.credits.cast.slice(0, 10).forEach(function (val: any) {
                    actors.push(val.name);
                });
            }
            if (item.credits && item.credits.crew) {
                item.credits.crew.forEach(function (val: any) {
                    if (val.job === "Director") director.push(val.name);
                    else if (val.job === "Screenplay") script.push(val.name);
                });
            }
            const hk = getViewportHeightScale();
            const poster = item.poster_path
                ? "https://image.tmdb.org/t/p/w500/" + item.poster_path
                : "";
            const backdrop = item.backdrop_path
                ? "https://image.tmdb.org/t/p/w500/" + item.backdrop_path
                : "";
            return (
                '<div id="_prdD" style="margin: -' +
                10 * hk +
                "px; background-position: right -200px top; background-size: cover; background-repeat: no-repeat; background-image: url(" +
                metadataText(metadataCssUrl(backdrop)) +
                ');"><div style="padding:' +
                20 * hk +
                'px; background: rgba(13, 37, 63, 0.8);"><table>' +
                (poster
                    ? '<img height="' +
                      300 * hk +
                      '" width="' +
                      200 * hk +
                      '" src="' +
                      metadataText(poster) +
                      '" style="float: left; margin-right: ' +
                      10 * hk +
                      "px; margin-bottom: " +
                      10 * hk +
                      'px; border-width: 0px;" onerror="this.width=0;this.height=0;">'
                    : "") +
                '<div style="text-align:center;font-size:larger;">' +
                metadataText(item.title || item.name) +
                "</div><br>" +
                it((item.release_date || "").split("-")[0], "Year") +
                it(
                    Math.round(item.runtime || item.episode_run_time || 0) +
                        " " +
                        _("min"),
                    "Duration"
                ) +
                it(genre.join(", "), "Genre") +
                it(country.join(", "), "Country") +
                it(actors.join(", "), "Actors") +
                it(director.join(", "), "Director") +
                it(script.join(", "), "Script") +
                it(item.vote_average, "Rating") +
                (item.overview ? "<hr>" + metadataText(item.overview) : "") +
                "</table></div></div>"
            );
        }
        function show() {
            $("#dialogbox").html(renderMediaDescription(TMDb.data)).show();
            (window as any).dialogBoxKeyHandler = function (key: any) {
                const keys = (window as any).keys || {};
                if (key === keys.RETURN || key === keys.EXIT) {
                    $("#dialogbox").hide();
                    if (TMDb.results && TMDb.results.length > 1) {
                        setTimeout(function () {
                            TMDb.select();
                        }, 0);
                    }
                    return true;
                }
                return false;
            };
        }
        if (TMDb.media_type_id === media_type + "/" + id) {
            show();
            return;
        }
        TMDb.media_type_id = media_type + "/" + id;
        $.ajax({
            cache: false,
            data: { append_to_response: "credits", language: api_lang },
            dataType: "json",
            error: function (jqXHR: any) {
                if (TMDb.locale() !== api_lang) return;
                $("#dialogbox").html(
                    "<br>" + metadataText(_("Failed to load!")) + "<br><br>"
                );
                console.log("getTMDB jqXHR:" + JSON.stringify(jqXHR));
            },
            success: function (data: any) {
                if (TMDb.locale() !== api_lang) return;
                TMDb.data = data;
                show();
            },
            timeout: 30000,
            url: TMDb.apiPath(media_type + "/" + id),
        });
    },
    hk: 1,
    locale: function (): string {
        var language = languageLocaleTag(
            (window as any).__ottInterfaceLanguage ||
                stbGetItem("ottplaylang") ||
                "_eng"
        );
        if (TMDb.currentLanguage !== language) {
            TMDb.currentLanguage = language;
            TMDb.media_type_id = "";
            TMDb.query = "";
            TMDb.results = [];
            TMDb.data = null;
        }
        return language;
    },
    media_type_id: "",
    prepare: function () {},
    query: "",
    results: [] as any[],
    search: function (nam: string, itr?: number) {
        if (!hasTmdbService()) return;
        const $ = (window as any).$;
        const _ =
            (window as any)._ ||
            function (s: string) {
                return s;
            };
        const api_lang = TMDb.locale();
        itr = itr || 0;
        nam = String(nam || "");
        nam = nam.replace(/["\u00AB\u00BB]/g, "");
        nam = nam.replace(/&(?:quot|amp|lt|gt|laquo|raquo);/gi, "");
        for (let _i = 0; _i < 8; _i++) {
            const next = nam.replace(/\([^()]*\)|\[[^\[\]]*\]/g, "");
            if (next === nam) break;
            nam = next;
        }
        nam = nam.replace(/\s?\S\/\S\s/g, " ");
        nam = nam.replace(/\s+/g, " ").trim();
        let name = nam;
        const an = name.split(" ");
        (window as any).dialogBoxKeyHandler = function () {
            $("#dialogbox").hide();
        };
        if (!itr) {
            if (nam !== TMDb.query) TMDb.query = nam;
            else
                switch (TMDb.results.length) {
                    case 0:
                        $("#dialogbox").html("<br>" + _("Not found") + "!<br>");
                        return;
                    case 1:
                        TMDb.get(
                            TMDb.results[0].media_type,
                            TMDb.results[0].id
                        );
                        return;
                    default:
                        TMDb.select();
                        return;
                }
        }
        switch (itr) {
            case 0:
                break;
            case 1:
                an.pop();
                name = an.join(" ");
                break;
            case 2:
                an.shift();
                name = an.join(" ");
                break;
            case 3:
                an.shift();
                an.pop();
                name = an.join(" ");
                break;
            default:
                an.pop();
                name = an.join(" ");
                break;
        }
        if (!name) {
            $("#dialogbox").html("<br>" + _("Not found") + "!<br>");
            return;
        }
        $("#dialogbox")
            .html(
                "<br>" + _("Search") + ":<br>" + metadataText(name) + "<br><br>"
            )
            .show();
        $.ajax({
            cache: false,
            data: {
                include_adult: true,
                language: api_lang,
                page: 1,
                query: name,
            },
            dataType: "json",
            error: function (jqXHR: any) {
                if (TMDb.locale() !== api_lang) return;
                $("#dialogbox").html(
                    "<br>" + metadataText(_("Failed to load!")) + "<br><br>"
                );
                console.log("searchTMDB jqXHR:" + JSON.stringify(jqXHR));
            },
            success: function (data: any) {
                if (TMDb.locale() !== api_lang) return;
                data.results = (data.results || []).filter(function (val: any) {
                    return (
                        val.media_type === "movie" || val.media_type === "tv"
                    );
                });
                TMDb.results = data.results;
                if (data.results.length > 1) {
                    TMDb.results = data.results.filter(function (val: any) {
                        return (val.title || val.name) === TMDb.query;
                    });
                    if (!TMDb.results.length) TMDb.results = data.results;
                }
                TMDb.sel = -1;
                switch (TMDb.results.length) {
                    case 0:
                        TMDb.search(name, 1);
                        return;
                    case 1:
                        TMDb.get(
                            TMDb.results[0].media_type,
                            TMDb.results[0].id
                        );
                        return;
                    default:
                        TMDb.select();
                        return;
                }
            },
            timeout: 30000,
            url: TMDb.apiPath("search/multi"),
        });
    },
    sel: -1,
    select: function () {
        const $ = (window as any).$;
        const keys = (window as any).keys || {};
        TMDb.hk = (window as any).getViewportHeightScale
            ? (window as any).getViewportHeightScale()
            : 1;
        TMDb.fun = (window as any).sInfoSlide ? "animate" : "css";
        let s =
            '<span id="_sel">1</span>/' +
            TMDb.results.length +
            '<div id="_tmdb" style="clear:both;overflow:hidden;"><div id="tmdb" style="white-space:nowrap;position:relative;">';
        TMDb.results.forEach(function (val: any, ind: number) {
            const poster = val.poster_path
                ? "https://image.tmdb.org/t/p/w500/" + val.poster_path
                : "";
            s +=
                '<div id="tmdb' +
                ind +
                '" style="display: inline-block; height:' +
                300 * TMDb.hk +
                "px; width:" +
                150 * TMDb.hk +
                "px; background-position: center; background-size: contain; background-repeat: no-repeat; background-image: url(" +
                metadataText(metadataCssUrl(poster)) +
                ');" onclick="TMDb.setSelect(' +
                ind +
                ');"></div>';
        });
        s += "</div></div>";
        $("#dialogbox").html(s).show();
        if (TMDb.sel === -1) TMDb.setSel(0);
        else {
            const i = TMDb.sel;
            TMDb.sel = -1;
            TMDb.setSel(i);
        }
        (window as any).dialogBoxKeyHandler = function (key: any) {
            switch (key) {
                case keys.UP:
                    TMDb.setSel(0);
                    break;
                case keys.DOWN:
                    TMDb.setSel(TMDb.results.length - 1);
                    break;
                case keys.LEFT:
                    if (TMDb.sel) TMDb.setSel(TMDb.sel - 1);
                    break;
                case keys.RIGHT:
                    if (TMDb.sel < TMDb.results.length - 1)
                        TMDb.setSel(TMDb.sel + 1);
                    break;
                case keys.ENTER:
                    TMDb.get(
                        TMDb.results[TMDb.sel].media_type,
                        TMDb.results[TMDb.sel].id
                    );
                    break;
                case keys.RETURN:
                case keys.EXIT:
                    $("#dialogbox").hide();
                    break;
                default:
                    break;
            }
            return true;
        };
    },
    setSel: function (i: number) {
        if (TMDb.sel === i) return;
        const $ = (window as any).$;
        try {
            $("#tmdb" + TMDb.sel)[TMDb.fun](
                { width: 150 * TMDb.hk + "px" },
                200
            );
        } catch (_e) {}
        TMDb.sel = i;
        try {
            $("#_sel").text(TMDb.sel + 1);
            $("#tmdb" + TMDb.sel)[TMDb.fun](
                { width: 200 * TMDb.hk + "px" },
                200
            );
        } catch (_e2) {}
    },
    setSelect: function (i: number) {
        if (TMDb.sel === i) {
            const keys = (window as any).keys || {};
            if ((window as any)._doKey) (window as any)._doKey(keys.ENTER);
        } else TMDb.setSel(i);
    },
};

// Feedback
// sendClientFeedback and queueFeedbackPost defined in utils/helpers.ts

// Performance stamps
var perfStamps: string[] = [];

// Script loading
declare function loadScript(
    url: string,
    successCb: () => void,
    errorCb?: (e: any) => void,
    location?: HTMLElement
): void;
declare function getScriptDOM(
    url: string,
    successCb: () => void,
    errorCb?: () => void
): void;

// Capture the original storage functions before provider scripts replace globals.
// loadProv restores these references. Forwarding wrappers would recurse once
// their names and the provider globals share the concatenated script scope.
var _providerGetItem = providerGetItem;
var _providerHasItem = providerHasItem;
var _providerHasItemValue = providerHasItemValue;
var _providerSetItem = providerSetItem;
var _providerDelItem = providerDelItem;

// Settings helpers

/**
 * Apply the configured timezone offset from settings.
 * Uses the timezone polyfill for clocks and EPG display, preserving epochs.
 */
function setTimezone(): void {
    var index = applyTimezoneSetting(settings.timezone);
    settings.timezone = index;
    (window as any).sTimezone = index;
}

// UI-related DOM element references
var $i1: any;
var tooltip: HTMLElement | null = null;
var $tooltipSpan: any;

/**
 * Cache jQuery references to frequently-used DOM elements.
 * Must be called after the DOM is ready and #info1 / #progress_span exist.
 *
 * Side effects: Assigns module-level $i1, tooltip, $tooltipSpan.
 */
function initUIReferences(): void {
    $i1 = $("#info1");
    tooltip = document.getElementById("progress_span");
    if (tooltip) $tooltipSpan = $("span", tooltip);
}

/**
 * Calculate and apply font sizes, padding, and element dimensions based on
 * window/screen resolution, pageSize, and fontShift settings.
 * Also applies font family from settings.fontSize, toggles permanentTime
 * visibility, and dynamically adjusts widths for channel number, picon,
 * time labels, and program name using a test-font measurement technique.
 *
 * Side effects: Extensive DOM mutations on #list, #info1, #numprog,
 * #dialogbox, #listCaption, #listPodval, #permanentTime, #picon, #channel,
 * #progress, #descr, #buffering, #pip_buffering, #mute, #volume_div,
 * and many more. Calls stbCSS() if available. Hides .no_small elements
 * when settings.noSmall is set.
 */
function setFontSize(): void {
    pageSize = settings.pageSize;
    setListPos();
    var $i1El = $i1 && typeof $i1.css === "function" ? $i1 : null;
    var e = window.innerHeight / 720;
    var t = window.innerWidth / 1280;
    // Companion OTT setFontSize uses 90-chrome for glyph size; showPage rows
    // use 130-chrome / live #listIn via listRowHeight. fontShift shrinks
    // glyphs inside the row line-box. Clamp to the real row box so WKWebView
    // cannot expand #itN past pageSize packing (90-chrome alone was taller).
    var rowPx =
        typeof (window as any).listRowHeight === "function"
            ? (window as any).listRowHeight(pageSize)
            : Math.floor((window.innerHeight - 130 * e) / pageSize);
    rowPx = Math.max(1, Math.floor(rowPx));
    // +1 step vs prior formula: empty space remained under pageSize=25 rows.
    var r =
        (window.innerHeight - 90 * e) / pageSize - settings.fontShift * e + e;
    r = Math.max(r, 16 * e);
    // Keep glyphs inside the integer row box (WKWebView expands on overflow).
    // 0.98 uses the spare line-box under the 25th row after the +1 step bump.
    r = Math.min(r, 40 * e, Math.max(10 * e, rowPx * 0.98));
    $("#list, #testFont, #permanentTime").css("font-size", r + "px");

    r = Math.max(r, 22 * e);
    if ($i1El) $i1El.css("font-size", r + "px");
    $("#numprog, #dialogbox").css("font-size", r + "px");

    r = Math.min(r, 28 * e);
    $("#listCaption, #listPodval").css("font-size", r + "px");
    $("#permanentTime")
        .toggle(settings.permanentTime !== 0 && !isListVisible)
        .toggleClass("osd", settings.permanentTime !== 2)
        .css("background-color", "");
    stbSetOsdOpacity(settings.osdOpacity * 10);

    var s = (window as any).__ottNativeFontFamilies
        ? ""
        : "Helvetica, Arial, sans-serif";
    $("body").css("font-family", fontFamilyList[settings.fontSize] + s);

    $("#info").css("padding", 20 * e + "px");
    $("#numprog").css({
        left: 20 * e + "px",
        padding: 10 * e + "px",
        top: 20 * e + "px",
    });
    $("#permanentTime").css({
        padding: 10 * e + "px " + 10 * t + "px",
        right: 20 * t + "px",
        top: 20 * e + "px",
    });
    $("#launch").css({ "font-size": 20 * e + "px", padding: 100 * e + "px" });
    $("logo").css({ margin: 100 * e + "px" });
    $("#listTime").css("font-size", 22 * e + "px");
    $("#list_s").css({ "font-size": 16 * e + "px" });
    $("#info1").css({ padding: 20 * e + "px " + 20 * t + "px" });
    $("#picon").css({ height: 80 * e + "px", width: 80 * t + "px" });
    $("#channel").css({
        padding: "0px 0px 0px " + 20 * t + "px",
        width: 1040 * t + "px",
    });
    $("#channel_number").css({ width: 70 * t + "px" });
    $("#progress_div").css({ margin: 6 * e + "px 0px " + 4 * e + "px 0px" });
    $("#progress, #progress_r").css({ height: 8 * e + "px" });
    $("#begin_time, #end_time").css({
        "font-size": 22 * e + "px",
        width: 70 * t + "px",
    });
    $("#programm_name").css({ width: 900 * t + "px" });
    $("#nbegin_time, #nend_time").css({
        "font-size": 20 * e + "px",
        width: 70 * t + "px",
    });
    $("#nprogramm_name").css({ width: 900 * t + "px" });
    $("#data").css({ "font-size": 22 * e + "px", width: 80 * t + "px" });
    $("#current_s, #video_res").css({ "font-size": 16 * e + "px" });
    $("#descr").css({
        margin: "0px 0px " + 20 * e + "px 0px",
        padding: "0px " + 100 * t + "px",
    });
    $("#buffering").css({
        height: 30 * e + "px",
        left: 10 * e + "px",
        top: 10 * e + "px",
        width: 30 * e + "px",
    });
    $("#pip_buffering").css({
        height: 30 * e + "px",
        right: 10 * e + "px",
        top: 10 * e + "px",
        width: 30 * e + "px",
    });
    $("#mute").css({
        "background-size": 20 * e + "px",
        height: 40 * e + "px",
        width: 40 * e + "px",
    });
    $("#volume_div").css({
        border: 5 * e + "px solid black",
        left: 10 * t + "px",
        width: 15 * t + "px",
    });
    $("#dialogbox").css({
        margin: 10 * e + "px",
        padding: 14 * e + "px " + 16 * t + "px",
    });
    $("btn").css({
        "border-radius": 6 * e + "px",
        padding: "0px " + 6 * t + "px",
    });

    try {
        if (tooltip && tooltip.style) {
            tooltip.style.width = 12 * e + "px";
            tooltip.style.height = 12 * e + "px";
            tooltip.style.border = 3 * e + "px solid " + curColor;
        }
    } catch (ex) {
        console.error(ex);
    }

    // Dynamic picon/data/listTime width based on font metrics
    try {
        var n = $("#testFont"),
            i = n.css("font-size");
        n.css("font-size", 22 * e).text("9");
        var a = n.width();
        n.text("").css("font-size", i);
        var o = a * 7;
        if (o) {
            $("#picon, #data, #listTime").css({ width: o + "px" });
            $("#channel").css({ width: 1200 * t - o * 2 + "px" });
            $("#descr").css({ padding: "0px " + (o + 20 * t) + "px" });
        }
    } catch (ex) {
        console.error(ex);
    }

    // Dynamic channel_number/begin/end_time/programm_name width
    try {
        var n2 = $("#testFont"),
            i2 = n2.css("font-size"),
            l2 = $i1El ? $i1El.css("font-size") : "22px";
        n2.css("font-size", l2).text("9");
        var a2 = n2.width();
        n2.text("").css("font-size", i2);
        if (a2) {
            // Finite-media programme clocks include seconds (HH:mm:ss).
            var w = a2 * 8;
            // ~2 inline-block HTML whitespace gaps between begin/name/end
            var gap = Math.max(8, Math.round(a2));
            $("#channel_number").css({ width: w + "px" });
            $("#begin_time, #end_time").css({
                "font-size": "inherit",
                width: w + "px",
            });
            // Legacy: channel.width - digitWidth*12 (= begin + end columns)
            var chW = $("#channel").width() || 1040 * t;
            var nameW = Math.max(40, chW - w * 2 - gap);
            $("#programm_name").css({ width: nameW + "px" });
            $("#nbegin_time, #nend_time").css({
                "font-size": "inherit",
                width: w + "px",
            });
            $("#nprogramm_name").css({ width: nameW + "px" });
        }
    } catch (ex) {
        console.error(ex);
    }

    $(".no_small").toggle(!settings.noSmall);

    try {
        if (typeof (window as any).stbCSS === "function")
            (window as any).stbCSS();
        $("#descr").css(
            "max-height",
            Math.max(0, 660 * e - $("#channel").height()) + "px"
        );
    } catch (ex) {
        console.error(ex);
    }
}

/**
 * Position the channel list panel on the left or right side of the screen
 * depending on settings.listPosition. Also adjusts the detail panel and
 * popup containers accordingly.
 *
 * Side effects: CSS position changes on #listIn, #listAbout, #listEdit,
 * #listDetail, #listPopUp via jQuery.
 */
function setListPos(): void {
    var x = window.innerWidth / 1280;
    var y = window.innerHeight / 720;
    var pli = settings.interfaceTheme === 1;
    var studio = settings.interfaceTheme === 2;
    var flipped = settings.listPosition;
    var inset = studio ? 40 : pli ? 60 : 0;
    var split = studio ? 520 : pli ? 530 : 522;
    var top = studio ? 100 * y : pli ? 110 * y : 52 * y + 1;
    var bottom = studio ? 80 * y : pli ? 100 * y : top;
    var preview = listPreviewRect(settings.interfaceTheme, flipped);
    $("#list").css({
        margin: pli || studio ? "0" : 10 * y + "px " + 10 * x + "px",
    });
    var lineHeight = (studio ? 72 : pli ? 88 : 52) * y + "px";
    $("#listCaption, #listPodval").css({
        height: (studio ? 74 : pli ? 90 : 52) * y,
        "line-height": lineHeight,
        padding: "0 " + (studio ? 40 : pli ? 85 : 12) * x + "px",
    });
    $("#listTime").css({
        height: lineHeight,
        "line-height": lineHeight,
        right: inset * x,
        width: (pli ? 150 : 88) * x,
    });
    $("#listIn, #listAbout, #listEdit").css({
        bottom: bottom,
        left: (flipped ? inset : split) * x,
        right: (flipped ? split : inset) * x,
        top: top,
    });
    $("#listIn").css("padding", pli || studio ? "0" : 4 * y + "px 0");
    $("#listAbout, #listEdit").css("padding", 14 * y + "px " + 16 * x + "px");
    $("#listDetail, #listPopUp").css({
        bottom: bottom,
        left: (pli || studio ? preview.left : flipped ? 738 : 0) * x,
    });
    $("#listDetail").css({
        padding: pli || studio ? "0" : 10 * y + "px " + 14 * x + "px",
        top: studio
            ? (settings.noSmall ? 100 : 368) * y
            : pli
              ? (settings.noSmall ? 110 : 360) * y
              : settings.noSmall
                ? top
                : 330 * y,
        width: pli || studio ? preview.width * x : 514 * x + 1,
    });
    $("#listPopUp").css({
        margin: 10 * y,
        padding: 14 * y + "px " + 18 * x + "px",
    });
    // The opaque mask and the video use the same rectangle, including mirroring.
    $("#_t").css("height", preview.top * y);
    $("#_b").css("top", (preview.top + preview.height) * y);
    $("#_l").css("width", preview.left * x);
    $("#_r").css("left", (preview.left + preview.width) * x);
}

/** Convert validated Classic H,S at fixed V, or background H,V at S=100. */
function classicColorRgb(value: string, brightness?: number): string {
    var pair = value.split(",");
    return hsvToRgb(
        Number(pair[0]),
        brightness ? Number(pair[1]) : 100,
        brightness || Number(pair[1])
    ).join(",");
}

/**
 * Apply highlight colors (foreground, selection background, list background)
 * from HSV settings to the DOM. Computes RGB values, writes to body color,
 * list borders, progress bars, dialog boxes, OSD opacity, and the window
 * frame elements (#_t, #_b, #_l, #_r).
 *
 * Side effects: Extensive DOM CSS mutations. Calls stbSetOsdOpacity().
 * Reads settings.highlightColor, highlightColorSel, highlightColorB,
 * osdOpacity, listPosition.
 */
function setColor(): void {
    var pliHd = settings.interfaceTheme === 1;
    var studio = settings.interfaceTheme === 2;
    $("body").toggleClass("theme-pli-hd", pliHd);
    $("body").toggleClass("theme-studio", studio);
    bodyColor = studio ? "#f0f3f1" : "#f0f0f0";
    $("body").css("color", bodyColor);
    // PLi-HD's selectedFG / selectedBG. Keep the saved Classic palette intact.
    curColorB = studio
        ? "#2b4437"
        : pliHd
          ? "#303240"
          : "rgb(" + classicColorRgb(settings.highlightColorSel, 50) + ")";
    curColor = studio
        ? "#8bddb8"
        : pliHd
          ? "#fcc000"
          : "rgb(" + classicColorRgb(settings.highlightColor, 100) + ")";
    // Keep window.* in sync — itemEPG / listDetail / getListItem read w.curColor.
    window.curColor = curColor;
    window.curColorB = curColorB;
    window.bodyColor = bodyColor;

    var borderColor = studio ? "#2b3430" : pliHd ? "#555555" : curColor;
    $("#listCaption").css("border-bottom", "2px solid " + borderColor);
    $("#listPodval").css("border-top", "1px solid " + borderColor);
    $("#listPopUp, #dialogbox").css("border", "1px solid " + borderColor);
    $("#progress").css("background-color", curColor);
    if ($tooltipSpan && typeof $tooltipSpan.css === "function") {
        $tooltipSpan.css({ "background-color": curColorB, color: curColor });
    }
    $("#programm_name2").css("color", curColor);
    try {
        if (tooltip && tooltip.style)
            tooltip.style.border =
                (pliHd ? 1 : 3) * (window.innerHeight / 720) +
                "px solid " +
                borderColor;
    } catch (e) {
        console.error(e);
    }
    stbSetOsdOpacity(settings.osdOpacity * 10);

    var bgColor = studio
        ? "#0e1114"
        : pliHd
          ? "#000000"
          : "rgb(" + classicColorRgb(settings.highlightColorB) + ")";
    $(".list_back").css("background-color", bgColor);
    $("#listPopUp").css("background-color", bgColor);
}

/**
 * Set the OSD (on-screen display) background opacity.
 * Computes an rgba() value from the highlight color B (HSV) and the
 * given opacity percentage, then applies it to all elements with
 * class "osd".
 *
 * @param val - Opacity percentage (0–100, but typically 0–10 mapped from
 *              osdOpacity setting).
 *
 * Side effects: CSS background-color on .osd elements.
 */
function stbSetOsdOpacity(val: number): void {
    var rgb =
        settings.interfaceTheme === 2
            ? "14,17,20"
            : settings.interfaceTheme === 1
              ? "8,8,8"
              : classicColorRgb(settings.highlightColorB);
    $(".osd").css("background-color", "rgba(" + rgb + "," + val / 100 + ")");
}

/**
 * Select the editor implementation (built-in OSK or native input line).
 * On PC/Tauri/desktop and Capacitor (iOS/Android), always forces native
 * showEditKey2 (and persists sEditor=1). On STB, routes from settings.editor
 * / window.sEditor like original stbPlayer.js.
 *
 * window.editKey and window.showEditKey.
 */
function setEditor(): void {
    // Match setListPos/setColor: settings may have been updated via window.s*
    // (first-run / STB settings) while the channels module binding stays at 0.
    var w = window as any;
    var isPc =
        typeof w.__TAURI__ !== "undefined" ||
        /^(pc|pc2|tauri|desktop|nodejs)$/.test(String(w.ott_device || ""));
    // Cap Mode B mobile: system keyboard via showEditKey2 (same as desktop).
    // Do not treat generic ott_device=android STB builds as Cap.
    var isCap = typeof w.Capacitor !== "undefined";
    // Native shells support only the system input line.
    if (isPc || isCap) {
        // Desktop/Cap: native input only (OSK remains for non-Cap STB via sEditor=0).
        var raw =
            typeof w.stbGetItem === "function" ? w.stbGetItem("sEditor") : null;
        settings.editor = 1;
        w.sEditor = 1;
        if (typeof w.stbSetItem === "function" && String(raw) !== "1") {
            saveSettings({ editor: 1 });
        }
    }
    if (settings.editor && typeof w.showEditKey2 === "function") {
        w.editKey = w.editKey2;
        w.showEditKey = w.showEditKey2;
    } else {
        w.editKey = w.editKey1;
        w.showEditKey = w.showEditKey1;
    }
}

/**
 * Apply the configured PiP (Picture-in-Picture) window position and size.
 * Delegates to setPipPosition() from the core module.
 *
 * Side effects: DOM mutations via setPipPosition().
 */
function setPipPosBuf(): void {
    setPipPosition();
}

// Channel list functions

/**
 * Show the top-level category list. Displays catsArray labels and
 * installs a minimal key handler (ENTER plays, RETURN/EXIT closes).
 *
 * Side effects: Sets isListVisible, listDataArray, listSelectionIndex;
 * installs list handler functions; calls showPage().
 *
 * Edge case: This is a simplified stub — the full channel list with EPG
 * and progress bars is rendered by _channelsList in the provider module.
 */
function showFallbackCategoryList(): void {
    isListVisible = true;
    listDataArray = catsArray.slice();
    listSelectionIndex = catIndex >= 0 ? catIndex : 0;
    getListItemFn = function (item: any, _idx: number) {
        return "&nbsp;&nbsp;" + item;
    };
    detailListActionFn = function () {};
    listKeyHandlerFn = function (key: number) {
        switch (key) {
            case 13: // ENTER
                // Close the list; playback stays on the current channel
                // (provider module replaces this handler when loaded).
                closeList();
                isListVisible = false;
                return true;
            case 8: // RETURN
            case 27: // EXIT
                closeList();
                isListVisible = false;
                return true;
        }
        return false;
    };
    showPage();
}

// Archive playback

// Media info update

/**
 * Refresh finite-media progress and the video-resolution display.
 * Uses the shared UI renderer, which reads time from the active STB adapter.
 */
function updateMediaInfoDisplay(): void {
    updateMediaInfo();
}

// Check media (detect archive)
var mediaCheckTimer: any = null;

/**
 * Detect finite channel media. Local videos accept any positive finite duration;
 * other providers retain the > 180s and < 1,000,000s recording heuristic.
 * Reclassifies playback without replacing its session or backend.
 *
 * Side effects: Updates window.playType, window.playTime; calls
 * updateMediaInfoDisplay(). Clears mediaCheckTimer.
 */
function checkMedia(): void {
    clearTimeout(mediaCheckTimer);
    if (video) {
        var duration = stbGetLen();
        var driver = (window as any).__ottActiveProviderDriver;
        var localFile = driver && driver.id === "offline";
        if (
            duration > 0 &&
            isFinite(duration) &&
            (localFile || (duration > 180 && duration < 1000000))
        ) {
            var playback = (window as any).__ottClassicPlayback;
            if (playback && typeof playback.command === "function")
                playback.command({
                    duration: duration,
                    type: "finite-channel",
                });
            else {
                window.playTime = 0;
                window.playType = -99999999999;
            }
            updateMediaInfoDisplay();
        }
    }
}

// Unload handler

/** Persist the active target without changing playback when the page is hidden. */
function body_onUnload(): void {
    var playback = (window as any).__ottClassicPlayback;
    if (playback && typeof playback.snapshot === "function") {
        try {
            var backend = (window as any).__ottCoreBackendPeek?.();
            var handle = backend && backend.current();
            if (handle && handle.active()) handle.sample();
        } catch (_) {
            // Keep the last observed clock if the decoder is already retiring.
        }
        var state = playback.snapshot();
        playback.checkpoint(state, true);
        // VOD has its own resume history. A hidden channel remains selected and
        // must not become its own "previous channel" entry.
        if (state.historyTarget && state.historyTarget.kind === "vod")
            setCurrent(catIndex, -1);
    } else setCurrent(catIndex, primaryIndex);
}

/**
 * Handle the visibilitychange event. When the page becomes hidden
 * (tab switched, browser minimised), persists state via body_onUnload().
 *
 * Side effects: Calls body_onUnload() if document.hidden.
 */
function body_onUnloadHidden(): void {
    if (document.hidden) body_onUnload();
}
if (navigator.userAgent.search(/Maple/i) === -1) {
    if (document.addEventListener) {
        document.addEventListener("visibilitychange", body_onUnloadHidden);
    } else if ((document as any).attachEvent) {
        (document as any).attachEvent(
            "onvisibilitychange",
            body_onUnloadHidden
        );
    }
    if (window.addEventListener) {
        try {
            window.addEventListener("beforeunload", body_onUnload);
        } catch (_) {
            /* ignore */
        }
        try {
            window.addEventListener("unload", body_onUnload);
        } catch (_) {
            /* ignore */
        }
    } else if ((window as any).attachEvent) {
        sendClientFeedback("is window.attachEvent");
        (window as any).attachEvent("onbeforeunload", body_onUnload);
        (window as any).attachEvent("onunload", body_onUnload);
    }
}

// Main initialization

/**
 * Called at the beginning of startPlayer(). Emits a performance stamp
 * and logs to console. Stub for future startup logic.
 */
function onPlayerStart(): void {
    console.log("onPlayerStart");
}

// Language selection

/**
 * Show system/manual language choices and search while preserving stored IDs.
 * Renders all packaged languages,
 * saves the selection to stb storage, loads the corresponding language
 * JS file from /locales/{language}.js, then proceeds to loadProv() or
 * optionsList depending on duneAddSettings availability.
 *
 * Side effects: Writes 'ottplaylang' to stb storage; dynamically loads
 * a language script via getScriptDOM; DOM mutations to list elements;
 * calls showPage().
 *
 * Edge cases:
 * - If duneAddSettings is a function (Dune environment), on ENTER/EXIT
 *   navigates to optionsList instead of loadProv / stbExit.
 * - If no language was previously selected, the launch element is hidden.
 */
/** One bounded owner for runtime locale downloads, including late scripts. */
function loadInterfaceLanguage(
    code: string,
    done: (loaded: boolean) => void
): () => void {
    var w = window as any,
        request = {},
        finished = false;
    w.__ottLanguagePending = request;
    w.__ottBootDictionary = w.keyStrings;
    var previous = w.keyStrings;
    function finish(loaded: boolean): void {
        if (finished || w.__ottLanguagePending !== request) {
            if (loaded) w.keyStrings = w.__ottBootDictionary;
            return;
        }
        finished = true;
        clearTimeout(timer);
        w.__ottLanguagePending = null;
        loaded =
            loaded &&
            w.keyStrings !== previous &&
            w.keyStrings &&
            typeof w.keyStrings.lang === "string";
        if (!loaded) w.keyStrings = w.__ottBootDictionary;
        else {
            w.__ottBootDictionary = w.keyStrings;
            applyLanguageMetadata(code);
        }
        done(!!loaded);
    }
    var timer = setTimeout(function () {
        finish(false);
    }, 10000);
    getScriptDOM(
        hostUrl + languageAssetPath(code) + "?" + PLAYER_VERSION,
        function () {
            finish(true);
        },
        function () {
            finish(false);
        }
    );
    return function () {
        finish(false);
    };
}

function selectLang(forceReload?: boolean, startup?: boolean): void {
    var langCodes = [
        "_eng",
        "_arm",
        "_bel",
        "_bul",
        "_fra",
        "_ger",
        "_gre",
        "_heb",
        "_hun",
        "_ita",
        "_lat",
        "_lit",
        "_pol",
        "_por",
        "_rou",
        "_rus",
        "_spa",
        "_tur",
        "_ukr",
        "_uzb",
        "_ind",
        "_vie",
        "_may",
        "_dut",
        "_cze",
        "_swe",
        "_aze",
        "_kaz",
        "_ara",
        "_chi",
        "_jpn",
        "_kor",
        "_per",
        "_hin",
        "_ben",
        "_urd",
        "_pan",
        "_mar",
        "_tel",
        "_tam",
        "_guj",
        "_kan",
        "_mal",
        "_nep",
        "_sin",
        "_tha",
        "_bur",
        "_khm",
        "_swa",
        "_fil",
        "_fin",
        "_dan",
        "_nor",
        "_est",
        "_slo",
        "_slv",
        "_hrv",
        "_srp",
        "_geo",
        "_alb",
        "_bos",
        "_mac",
        "_ice",
        "_cat",
        "_baq",
        "_glg",
        "_gle",
        "_mlt",
        "_pus",
        "_kur",
        "_tgk",
        "_kir",
        "_tuk",
        "_mon",
        "_lao",
        "_ori",
        "_asm",
        "_snd",
        "_afr",
        "_amh",
        "_hau",
        "_yor",
        "_ibo",
        "_som",
        "_zul",
        "_xho",
        "_mlg",
        "_kin",
    ];
    var languageHost = window as any;
    var currentCode = stbGetItem("ottplaylang") || "";
    var cancelled = false,
        query = "",
        visibleCodes: string[] = [];
    var cancelLanguageLoad: (() => void) | undefined;
    function systemCode(): string {
        return typeof languageHost.__ottDetectLanguage === "function"
            ? languageHost.__ottDetectLanguage()
            : "";
    }
    function resumeAfterLanguage(exit?: boolean): void {
        if (startup || typeof duneAddSettings !== "function") {
            if (exit === true) {
                closeList();
                stbExit();
            } else {
                loadProv();
                checkTauriUpdatesAfterLanguage();
            }
        } else if (typeof languageHost.optionsList === "function") {
            languageHost.optionsList(selectLang);
            checkTauriUpdatesAfterLanguage();
        }
    }
    function renderLanguages(): void {
        var needle = normalizeSearchText(query);
        visibleCodes = ["@system", "@search"].concat(
            langCodes.filter(function (code) {
                return (
                    !needle ||
                    normalizeSearchText(
                        languageNames[code] +
                            " " +
                            languageLocaleTag(code) +
                            " " +
                            code
                    ).indexOf(needle) !== -1
                );
            })
        );
        listDataArray = visibleCodes.map(function (code) {
            if (code === "@system") return _("System language");
            if (code === "@search")
                return _("Search languages") + (query ? ": " + query : "");
            return languageNames[code];
        });
        if (visibleCodes.length === 2) {
            visibleCodes.push("@empty");
            listDataArray.push(_("Not found"));
        }
        var selected =
            stbGetItem("ottplaylangmode") === "system"
                ? "@system"
                : currentCode;
        selIndex = visibleCodes.indexOf(selected);
        if (selIndex < 0)
            selIndex =
                visibleCodes.length > 2 && visibleCodes[2] !== "@empty" ? 2 : 1;
        showPage();
    }
    function searchLanguages(): void {
        if (
            languageHost.__ottLanguagePending ||
            typeof languageHost.showEditKey !== "function"
        )
            return;
        languageHost.editCaption = _("Search languages");
        languageHost.editvar = query;
        languageHost.setEdit = function () {
            if (cancelled || listKeyHandlerFn !== languageKeyHandler) return;
            query = String(languageHost.editvar || "").trim();
            languageHost.setEdit = function () {};
            renderLanguages();
        };
        languageHost.showEditKey(keys.ENTER);
    }
    getListItemFn = function (item: any) {
        return "&nbsp;&nbsp;" + metadataText(item);
    };
    detailListActionFn = function () {};
    var languageKeyHandler = function (key: number): boolean {
        switch (key) {
            case keys.RED:
                searchLanguages();
                return true;
            case keys.ENTER:
                if (languageHost.__ottLanguagePending) return true;
                var choice = visibleCodes[selIndex];
                if (choice === "@search") {
                    searchLanguages();
                    return true;
                }
                if (!choice || choice === "@empty") return true;
                var automatic = choice === "@system";
                var selectedLanguage = automatic ? systemCode() : choice;
                if (!selectedLanguage) {
                    infoBox(
                        _("No supported system language. Choose a language.")
                    );
                    return true;
                }
                var selected = function (): void {
                    cancelled = true;
                    stbSetItem("ottplaylang", selectedLanguage);
                    stbSetItem(
                        "ottplaylangmode",
                        automatic ? "system" : "manual"
                    );
                    applyLanguageMetadata(selectedLanguage);
                    resumeAfterLanguage();
                };
                // A saved system language can outlive a failed boot download.
                // Reuse only the dictionary that actually loaded this session.
                if (
                    languageHost.__ottInterfaceLanguage === selectedLanguage &&
                    forceReload !== true
                )
                    selected();
                else
                    cancelLanguageLoad = loadInterfaceLanguage(
                        selectedLanguage,
                        function (loaded) {
                            if (cancelled) return;
                            if (loaded) selected();
                            else infoBox(_("Failed to load!"));
                        }
                    );
                return true;
            case keys.EXIT:
                if (!startup && typeof duneAddSettings === "function")
                    return false;
            case keys.RETURN:
                cancelled = true;
                if (cancelLanguageLoad) cancelLanguageLoad();
                resumeAfterLanguage(true);
                return true;
        }
        return false;
    };
    listKeyHandlerFn = languageKeyHandler;
    function setLanguageHtml(id: string, html: string): void {
        var element = document.getElementById(id);
        if (element) element.innerHTML = html;
    }
    setLanguageHtml("listDetail", "");
    setLanguageHtml("listCaption", _("Choose language"));
    setLanguageHtml(
        "listPodval",
        renderButtonHint(keys.RETURN, strRETURN, "Close") +
            renderButtonHint(keys.RED, "", "Search languages")
    );
    var listPopUpEl = document.getElementById("listPopUp");
    if (listPopUpEl) listPopUpEl.style.display = "none";
    renderLanguages();
}

function startupError(
    launch: HTMLElement | null,
    label: string,
    error: any
): void {
    if (launch) {
        launch.appendChild(document.createElement("br"));
        launch.appendChild(document.createElement("br"));
        launch.appendChild(document.createElement("b")).textContent = _(
            "Player could not start"
        );
        launch.appendChild(
            document.createTextNode(
                label +
                    " " +
                    (error != null && error.name != null
                        ? error.name
                        : "Error") +
                    ": " +
                    (error != null && error.message != null
                        ? error.message
                        : String(error))
            )
        );
    }
    console.error(error);
}

// Main entry point

/**
 * Main entry point — called once the DOM is ready.
 * Initialises storage, UI, the STB layer, key handler, and triggers
 * the full startup chain (onStbReady → language → provider).
 *
 * Side effects: Resets storage, calls uiInit(), stbInit(), wires
 * window.onkeydown, calls onStbReady(). Appends version and icon to
 * the #launch element.
 *
 * Edge case: Wrapped in try/catch — exceptions are displayed in #launch.
 */
export function startPlayer(): void {
    if (showSettingsRecovery()) return;
    // Cap/Tauri boot leaves hostUrl ""; language packs + icons resolve via
    // absolute "/locales/…". Prefer location.origin when present so nested
    // Cap paths and capacitor://localhost match CSS/bundle host.
    try {
        if (!hostUrl) {
            var locHost =
                (typeof (window as any).host === "string" &&
                    (window as any).host) ||
                ((window as any).location && (window as any).location.origin) ||
                "";
            if (locHost && locHost !== "null" && locHost !== "file://") {
                hostUrl = locHost;
                (window as any).hostUrl = hostUrl;
            }
        }
    } catch (_hu) {}
    var launchEl = document.getElementById("launch");
    if (launchEl) {
        launchEl.innerHTML += "<br/>VER: " + PLAYER_VERSION;
    }

    onPlayerStart();

    try {
        console.log("startPlayer");

        // OTTPLAY_FULL_ONLY_BEGIN
        if (launchEl && !isPlayDistribution()) {
            launchEl.innerHTML +=
                '<img src="' +
                hostUrl +
                "/images/player-logo.png?" +
                PLAYER_VERSION +
                '" style="position: absolute; left: 100px; bottom:100px;" height="30%" alt=""/>';
        }
        // OTTPLAY_FULL_ONLY_END

        storage.reset();

        uiInit();
        initBackgroundIntervals();
        var deviceHost = window as any;
        if (deviceHost.__ottDevice) deviceHost.__ottDevice.dispose();
        deviceHost.__ottDevice = deviceHost.__ottDeviceAdapter.create({
            capabilities: function () {
                return {
                    audio:
                        typeof (window as any).stbAudioTracksExists ===
                            "function" &&
                        (window as any).stbAudioTracksExists(),
                    pip: typeof (window as any).stbPlayPip === "function",
                    subtitles:
                        typeof (window as any).stbSubtitleExists ===
                            "function" && !!(window as any).stbSubtitleExists(),
                };
            },
            clearInterval: function (id: number) {
                (window as any).clearInterval(id);
            },
            command: function (command: any) {
                deviceHost.__ottClassicPlayback.command(command);
            },
            duration: function () {
                return typeof (window as any).stbGetLen === "function"
                    ? (window as any).stbGetLen()
                    : NaN;
            },
            importLegacy: function () {
                return deviceHost.__ottClassicPlayback.importLegacy();
            },
            isManaged: function () {
                return (
                    (window as any).stbPlay ===
                    deviceHost.__ottCoreTransport.play
                );
            },
            key: function (event: any) {
                return (window as any).stbEventToKeyCode(event);
            },
            keys: function () {
                return deviceHost.keys;
            },
            now: function () {
                return Date.now();
            },
            playing: function () {
                return (window as any).stbIsPlaying();
            },
            position: function () {
                return typeof (window as any).stbGetPosTime === "function"
                    ? (window as any).stbGetPosTime()
                    : NaN;
            },
            route: function () {
                return deviceHost.ott_device;
            },
            setInterval: function (callback: () => void, delay: number) {
                return (window as any).setInterval(callback, delay);
            },
        });
        deviceHost.__ottDevice.start();
        (window as any).listFooter = (window as any).listFooterElement;
        if (typeof stbInit === "function" && (stbInit() as any) !== false) {
            onStbReady();
        }
    } catch (e) {
        startupError(launchEl, "startPlayer", e);
    }
}

// Post-STB-init setup

/** Reuse the successful early dictionary and commit first-run auto selection. */
function loadStartupLanguage(): boolean {
    var languageHost = window as any;
    // Retire any pre-standby language picker/download, including when startup
    // reuses the active dictionary and therefore starts no replacement request.
    languageHost.__ottLanguagePending = null;
    var standby = languageHost.__ottStandby;
    var generation = standby && standby.generation();
    function current(): boolean {
        return (
            !standby ||
            (languageHost.__ottStandby === standby &&
                standby.current(generation))
        );
    }
    var lang = stbGetItem("ottplaylang");
    // A wake reuses this session's verified dictionary, not a stale saved code
    // from an unsupported system language or a failed first-boot download.
    var active =
        Object.prototype.hasOwnProperty.call(languageNames, lang) &&
        languageHost.__ottInterfaceLanguage === lang &&
        languageHost.__ottBootDictionary === languageHost.keyStrings
            ? lang
            : "";
    var bootLanguage = (window as any).__ottBootLanguage;
    (window as any).__ottBootLanguage = null;
    var preloaded =
        bootLanguage &&
        Object.prototype.hasOwnProperty.call(
            languageNames,
            bootLanguage.code
        ) &&
        bootLanguage.dictionary === (window as any).keyStrings;
    var automatic = stbGetItem("ottplaylangmode") === "system" || !lang;
    if (automatic) {
        lang =
            preloaded && bootLanguage.automatic
                ? String(bootLanguage.code)
                : active;
        if (lang) {
            stbSetItem("ottplaylang", lang);
            stbSetItem("ottplaylangmode", "system");
        }
    }
    var launchEl = document.getElementById("launch");
    if (!lang) {
        console.log("TRACE no lang, calling selectLang()");
        if (launchEl) {
            launchEl.style.display = "none";
            if (typeof (window as any).clearBootHide === "function")
                (window as any).clearBootHide();
        }
        if (current()) selectLang(undefined, true);
        return false;
    }

    function ready(): void {
        if (!current()) return;
        (window as any).__ottBootDictionary = (window as any).keyStrings;
        loadProv();
        checkTauriUpdatesAfterLanguage();
    }
    if (
        (preloaded && bootLanguage.code === lang) ||
        (active && active === lang)
    ) {
        // Keep the script-load callback's ordering: onStbReady must install
        // native HTTP/EPG shims before a saved provider starts its first request.
        applyLanguageMetadata(lang);
        setTimeout(ready, 0);
        return true;
    }
    console.log("TRACE lang=" + lang + ", loading langJS");
    loadInterfaceLanguage(lang, function (loaded) {
        if (!current()) return;
        if (loaded) ready();
        else {
            var el = document.getElementById("launch");
            if (el) el.style.display = "none";
            if (typeof (window as any).clearBootHide === "function")
                (window as any).clearBootHide();
            selectLang(true, true);
        }
    });
    return true;
}

/**
 * Called after stbInit() completes. Responsible for:
 * - Merging device-specific key mappings
 * - Loading all settings from storage
 * - Syncing PlayerSettings to window.* globals
 * - Initialising UI references and applying visual settings
 * - Saving the current popup state for provider-switch restoration
 * - Loading the language file and then launching the provider
 * - Preparing TMDb if available
 *
 * Side effects: Extensive — calls loadSettings(), installSettingsFacade(),
 * setTimezone(), setFontSize(), setListPos(), setColor(), setEditor(),
 * setPipPosBuf(), setSleepTimeout(); loads language JS; calls loadProv()
 * to resume the configured source.
 *
 * Edge case: If no language is set, calls selectLang() directly and returns.
 * Wrapped in try/catch — exceptions are displayed in #launch.
 */
function onStbReady(): void {
    try {
        // Merge device-specific key mappings from window.keys (set by devices/{device}/device.js)
        if (typeof (window as any).keys !== "undefined") {
            Object.assign(keys, (window as any).keys);
        }
        // Load all settings
        loadSettings();
        // Sync PlayerSettings → window.* for settings submenu compatibility
        installSettingsFacade(window as any);
        (window as any).__ottKiosk.init();
        (window as any).__ottLocalHttpRemote.init();
        (window as any).__ottCommandServer.configure({
            address: settings.commandServerAddress,
            enabled: settings.commandServerEnabled === 1,
            token: settings.commandServerToken,
        });
        // Start connection-authorized diagnostics after saved settings and the
        // controller's initial configure callback have completed.
        if (!(window as any).__ottRemoteDiagnostics) initRemoteDiagnostics();
        // Device UUID for remote control / swop allowlist; optional /local/swop.json
        if (typeof (window as any).ensureDeviceClientId === "function")
            (window as any).ensureDeviceClientId();
        (window as any).__ottControlDiscovery.start();
        if (typeof (window as any).applyLocalSwopConfig === "function")
            (window as any).applyLocalSwopConfig();
        if ((window as any).__ottNasLibrary)
            (window as any).__ottNasLibrary.init();
        installLocalMedia(window);
        initUIReferences();

        // Apply settings
        if (typeof stbSetBuffer === "function") stbSetBuffer();
        setTimezone();
        setFontSize();
        setListPos();
        setColor();
        setEditor();
        setPipPosBuf();
        setSleepTimeout();
        closeList();

        // Expose edit globals for provider scripts (stalker, edem, etc.)
        // Providers assign window.setEdit, window.editCaption, window.editvar directly
        if (typeof (window as any).setEdit === "undefined")
            (window as any).setEdit = function () {};
        if (typeof (window as any).editKey === "undefined")
            (window as any).editKey = (window as any).editKey1;
        if (typeof (window as any).showEditKey === "undefined")
            (window as any).showEditKey = (window as any).showEditKey1;

        // Retain the pristine menu across wake; provider-owned/hidden entries
        // must not become the baseline for the next provider mount.
        if (!savedPopup.popupActions.length) {
            savedPopup.popupActions = popupActions.slice();
            savedPopup.popupArray = popupArray.slice();
            savedPopup.popupDetail = popupDetail.slice();
            savedPopup.ver = version;
        }

        // Install native transports even if startup pauses for language selection.
        // Re-apply Tauri IPC override after provider script loads.
        // This ensures the getChannelEpg override persists even when provider scripts
        // attempt to reset window.getChannelEpg (as they do in loadProv → getScriptDOM callback).
        if (typeof (window as any).__TAURI__ !== "undefined") {
            setupTauriEpgOverride();
            setupTauriEpgCacheReady();
            setupTauriCompanionShim();
            if (typeof setupStalkerPortalShim === "function")
                setupStalkerPortalShim();
        } else if (typeof (window as any).Capacitor !== "undefined") {
            setupCapacitorCompanionShim();
            if (typeof setupStalkerPortalShim === "function")
                setupStalkerPortalShim();
        }

        window.__ottStandby.ready(function () {
            if (window.__ottStandby.blocked()) {
                stbSetStandby(true);
                return;
            }
            if (TMDb && TMDb.prepare) TMDb.prepare();
            loadStartupLanguage();
        });
    } catch (e) {
        startupError(document.getElementById("launch"), "onStbReady", e);
    }
}

console.log("player loaded!");

// Expose globals for backward compat with HTML and other scripts
declare var window: any;
// @legacy-bridge: HTML starts the player after the selected device adapter loads.
// Required by: index.html (the only caller).
window.startPlayer = startPlayer;
// @legacy-bridge: post-init hook — merges window.keys, loads settings, starts provider.
// Required by: devices/{device}/device.js for device-specific key mappings.
window.onStbReady = onStbReady;
// @legacy-bridge: keyboard dispatch — called by devices/{device}/device.js on key events.
window.keyHandler = keyHandler;
window._doKey = dispatchKey;
window.keys = keys;

// Tauri IPC detection and EPG override
// When running under Tauri (Mode B), override getChannelEpg to use invoke()
// When running in browser/STB (Mode A), leave getChannelEpg unchanged for provider HTTP fetch

/**
 * Setup Tauri EPG override for getChannelEpg. Uses Tauri IPC instead of HTTP fetch.
 * Mode A (browser/STB): leaves getChannelEpg unchanged — provider HTTP fetch path.
 * Mode B (Tauri): passes playlist channel name + epg_url hash so Rust can resolve
 *   xmltv_id via match_channel / epg_to_xmltv (same as companion /epg/{hash}).
 * Invoke arg keys must be Tauri 2 camelCase: channelId, timeShiftHours,
 *   archiveHours. timeShiftHours is timezone only; archiveHours is catchup depth.
 */

/**
 * True when Tauri needs native companion routes (Mode B), including native dev.
 * Local HTTP companions on ports 8443–8446 keep their real /m3u/* HTTP routes.
 */
function isTauriEmbedMode(): boolean {
    if (typeof window.__TAURI__ === "undefined") return false;
    try {
        const location = window.location;
        if (
            String(location.protocol || "").toLowerCase() === "http:" &&
            /^(127\.0\.0\.1|localhost):844[3-6]$/i.test(
                String(location.host || "")
            )
        ) {
            return false;
        }
        return true;
    } catch (_e) {
        return true;
    }
}

/**
 * Generate a 120x90 SVG logo badge using the same djb2 colour-hash
 * as the Rust server (src-rs/server/src/main.rs generate_logo_svg).
 * Used to inline logo data URIs in Mode B where no companion server
 * hosts /logo/... endpoints.
 *
 * Keep this as a local function in index.ts (not a separate module):
 * the Vite stripModule + concat pipeline removes import/export lines.
 * ES5 target — use Math.imul / >>> 0 instead of BigInt.
 */
function tauriLogoSvg(logoId: string, chName: string): string {
    const COLORS = [
        "#e74c3c",
        "#3498db",
        "#2ecc71",
        "#f39c12",
        "#9b59b6",
        "#1abc9c",
        "#e67e22",
        "#34495e",
        "#16a085",
        "#c0392b",
        "#2980b9",
        "#27ae60",
        "#d35400",
        "#8e44ad",
        "#f1c40f",
    ];
    let h = 5381;
    for (let i = 0; i < logoId.length; i++) {
        h = (Math.imul(h, 33) + logoId.charCodeAt(i)) >>> 0;
    }
    const color = COLORS[h % COLORS.length];
    const trimmed = chName.trim();
    let letter: string;
    if (trimmed) {
        letter = trimmed.charAt(0).toUpperCase();
    } else {
        letter = String.fromCharCode(65 + (h % 26));
    }
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90">' +
        '<rect width="120" height="90" rx="8" fill="' +
        color +
        '"/>' +
        '<text x="60" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" font-weight="bold" fill="white">' +
        letter +
        "</text></svg>"
    );
}

/**
 * Replace `/logo/{id}.svg` (optional `?ch={name}`) patterns in match-logos
 * result text with inline data URIs so Mode B embed can paint logos without
 * a companion HTTP server. Matches relative and absolute-host /logo/*.svg
 * forms (e.g. http://tauri.localhost/logo/...). Other absolute http(s)
 * icon URLs that are not /logo/*.svg paths pass through unchanged.
 * Empty/missing ch → tauriLogoSvg picks a letter from the id hash.
 */
function rewriteLogoUrls(text: string): string {
    return text.replace(
        /([^~\n]+)~(?:https?:\/\/[^\/~\n]+)?\/logo\/([^?\n\/]+)\.svg(?:\?ch=([^&\n]*))?/g,
        function (
            _m: string,
            chId: string,
            logoId: string,
            chName: string | undefined
        ) {
            let name = chName || "";
            try {
                name = decodeURIComponent(name);
            } catch (_e) {
                /* keep raw */
            }
            const svg = tauriLogoSvg(logoId, name);
            return chId + "~data:image/svg+xml," + encodeURIComponent(svg);
        }
    );
}

/**
 * Absolute http(s) URL whose host is not a Tauri embed custom origin.
 * Real localhost / 127.0.0.1 must return true — that is the broken direct
 * XHR path for local hls-proxy playlists in Mode B.
 */
function isRemoteHttpUrlForProxy(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (
            host === "tauri.localhost" ||
            host === "ipc.localhost" ||
            host === "asset.localhost"
        ) {
            return false;
        }
        return true;
    } catch (_e) {
        return true;
    }
}

/**
 * Mode B: providers POST to host+"/m3u/cp.php" (CORS proxy) and
 * match-channels/logos. Embed has no Mode A HTTP server — those URLs 404 or
 * hang on tauri.localhost. Route cp.php through proxy_http invoke; route
 * match-* through native commands (after #298). Logo SVG paths from
 * match-logos are rewritten to data URIs so CSS backgrounds paint without
 * companion `/logo/...` HTTP. Version (`/version/<rel>`) and feedback
 * (`/feedback/*`, `/api/*`, `/report_feedb`) route through misc commands.
 *
 * Also: skip broken direct WKWebView XHR for remote http(s) playlist URLs
 * (e.g. http://127.0.0.1:8090). Mixed content from https://tauri.localhost,
 * or Content-Disposition:attachment bodies that arrive as empty "success",
 * can skip the cp.php fallback and leave catsArray empty (0/0/0). Route
 * those GETs through a native jQuery HTTP transport.
 */
function setupTauriCompanionShim(): void {
    if (!isTauriEmbedMode()) return;
    const $ = (window as any).$;
    if (
        !$ ||
        typeof $.ajax !== "function" ||
        typeof $.Deferred !== "function"
    ) {
        console.warn("[Tauri] companion shim: jQuery ajax unavailable");
        return;
    }
    if ((window as any).__ottTauriAjaxShim) return;
    (window as any).__ottTauriAjaxShim = true;
    const origAjax = $.ajax.bind($);
    // jQuery retains serialization, converters, callback order and jqXHR state.
    window.installTauriHttpTransport($, tauriInvoke);

    $.ajax = function (urlOrOpts: any, maybeOpts?: any) {
        if ((window as any).__ottStandby?.blocked())
            return origAjax(urlOrOpts, maybeOpts);
        let opts: any;
        if (typeof urlOrOpts === "string") {
            opts = Object.assign({}, maybeOpts || {}, { url: urlOrOpts });
        } else {
            opts = Object.assign({}, urlOrOpts || {});
        }
        const url = String(opts.url || "");

        // Remote providers, including an explicit !epg-server, keep their URL.
        // The registered native transport handles GET and external match POST;
        // never mistake a remote /m3u/* or /tmdb/* path for our companion API.
        if (isRemoteHttpUrlForProxy(url)) {
            return origAjax(opts);
        }

        if (url.indexOf("/m3u/cp.php") !== -1) {
            return origAjax(opts);
        }

        if (
            url.indexOf("/m3u/match-channels") !== -1 ||
            url.indexOf("/m3u/match-logos") !== -1
        ) {
            // Route match-channels / match-logos through native Tauri commands.
            // The body is opts.data (FOSS text protocol).
            const body = typeof opts.data === "string" ? opts.data : "";
            const cmd =
                url.indexOf("/m3u/match-channels") !== -1
                    ? "match_channels"
                    : "match_logos";
            const isLogos = cmd === "match_logos";
            return nativePromiseToJq(
                $,
                tauriInvoke<string>(cmd, { body, url }).then((text: string) =>
                    isLogos ? rewriteLogoUrls(text) : text
                ),
                opts,
                "proxy_fetch failed"
            );
        }

        // Mode A companion TMDB proxy: GET /tmdb/s/* (API) and /tmdb/i/* (images).
        // Embed has no companion — route through tmdb_proxy invoke (key stays in Rust).
        if (url.indexOf("/tmdb/") !== -1) {
            let pathPart = url;
            let query = "";
            const qIdx = pathPart.indexOf("?");
            if (qIdx !== -1) {
                query = pathPart.slice(qIdx + 1);
                pathPart = pathPart.slice(0, qIdx);
            }
            // Merge opts.data query fields when jQuery passes data separately.
            const data = opts.data;
            if (data) {
                let extra = "";
                if (typeof data === "string") {
                    extra = data;
                } else if (typeof data === "object") {
                    const parts: string[] = [];
                    for (const k of Object.keys(data)) {
                        parts.push(
                            encodeURIComponent(k) +
                                "=" +
                                encodeURIComponent(String((data as any)[k]))
                        );
                    }
                    extra = parts.join("&");
                }
                if (extra) {
                    query = query ? query + "&" + extra : extra;
                }
            }
            // Never forward a client api_key — Rust injects TMDB_API_KEY.
            if (query) {
                query = query
                    .split("&")
                    .filter((p) => p && !/^api_key=/i.test(p))
                    .join("&");
            }
            const invokePromise = tauriInvoke<{
                status: number;
                content_type: string;
                body: string;
                body_base64: string | null;
            }>("tmdb_proxy", { path: pathPart, query }).then((res) => {
                if (res.body_base64) {
                    const mime = res.content_type || "application/octet-stream";
                    return "data:" + mime + ";base64," + res.body_base64;
                }
                const text = res.body || "";
                if (
                    opts.dataType === "json" ||
                    (res.content_type &&
                        res.content_type.indexOf("json") !== -1)
                ) {
                    try {
                        return JSON.parse(text);
                    } catch (_e) {
                        return text;
                    }
                }
                return text;
            });
            return nativePromiseToJq(
                $,
                invokePromise,
                opts,
                "proxy_fetch failed"
            );
        }

        // Mode A companion: GET /version/<rel> → file metadata JSON.
        if (url.indexOf("/version/") !== -1) {
            let rel = url.slice(url.indexOf("/version/") + "/version/".length);
            const qIdx = rel.indexOf("?");
            if (qIdx !== -1) {
                rel = rel.slice(0, qIdx);
            }
            rel = rel.replace(/^\/+/, "");
            const invokePromise = tauriInvoke<{
                file: string;
                hash: string;
                modified: number;
                size: number;
            }>("get_version", { rel }).then((info) => {
                const text = JSON.stringify(info);
                if (opts.dataType === "json") {
                    return info;
                }
                return text;
            });
            return nativePromiseToJq(
                $,
                invokePromise,
                opts,
                "proxy_fetch failed"
            );
        }

        // Mode A companion: GET/POST /feedback/*, /api/*, POST /report_feedb.
        // queueFeedbackPost flushes to {host}/api/feedback — must work in embed.
        {
            let pathOnly = url;
            const qIdx = pathOnly.indexOf("?");
            if (qIdx !== -1) {
                pathOnly = pathOnly.slice(0, qIdx);
            }
            try {
                pathOnly = new URL(pathOnly, "http://tauri.localhost").pathname;
            } catch (_e) {
                /* keep pathOnly */
            }
            const isReport = pathOnly === "/report_feedb";
            const isFeedback =
                pathOnly === "/feedback" ||
                pathOnly.indexOf("/feedback/") === 0;
            const isApi =
                pathOnly === "/api" || pathOnly.indexOf("/api/") === 0;
            if (isReport || isFeedback || isApi) {
                const method = String(
                    opts.type || opts.method || "GET"
                ).toUpperCase();
                let body = "";
                const data = opts.data;
                if (typeof data === "string") {
                    body = data;
                } else if (data != null && typeof data === "object") {
                    try {
                        body = JSON.stringify(data);
                    } catch (_e) {
                        body = String(data);
                    }
                }
                const invokePromise = (
                    method === "POST" || method === "PUT" || method === "PATCH"
                        ? tauriInvoke<{ status: string; message?: string }>(
                              "feedback_post",
                              { body, path: pathOnly }
                          )
                        : tauriInvoke<{ status: string; message?: string }>(
                              "feedback_get",
                              { path: pathOnly }
                          )
                ).then((res) => {
                    const text = JSON.stringify(res);
                    if (opts.dataType === "json") {
                        return res;
                    }
                    return text;
                });
                return nativePromiseToJq(
                    $,
                    invokePromise,
                    opts,
                    "proxy_fetch failed"
                );
            }
        }

        return origAjax(opts);
    };
}

function setupTauriEpgOverride(): void {
    if (typeof window.__TAURI__ === "undefined") return;
    // Keep provider getChannelEpg intact. The shared cache chooses native XMLTV
    // only for the built-in M3U companion, and delegates all provider APIs.
    (window as any).getCachedChannelEpg = getChannelEpgCached;
}

/**
 * Listen for Rust `epg-cache-ready` (startup warm / refresh). Clears
 * old full schedules and time_request miss locks so channel list,
 * footer now/next, and EPG menu progressively refill once XMLTV is warm —
 * matching Mode A companion where the cache is already hot at first paint.
 */
function setupTauriEpgCacheReady(): void {
    if (typeof window.__TAURI__ === "undefined") return;
    if ((window as any).__ottEpgCacheReady) return;
    (window as any).__ottEpgCacheReady = true;
    const eventApi = (window as any).__TAURI__?.event;
    if (!eventApi || typeof eventApi.listen !== "function") {
        console.warn("[Tauri] epg-cache-ready: event.listen unavailable");
        return;
    }
    eventApi
        .listen("epg-cache-ready", function (_ev: any) {
            if ((window as any).__ottStandby?.blocked()) return;
            try {
                console.log("[Tauri] epg-cache-ready — refilling EPG");
                invalidateEpgCache(true);
                // Visible channel list: re-queue observeCurrentProgramme via showPage.
                if (
                    (window as any).isListVisible &&
                    typeof (window as any).showPage === "function"
                ) {
                    (window as any).showPage();
                }
                // footer / info1 for the playing channel.
                const curId =
                    typeof (window as any).curList !== "undefined" &&
                    typeof (window as any).primaryIndex === "number"
                        ? (window as any).curList[(window as any).primaryIndex]
                        : null;
                if (
                    curId != null &&
                    typeof (window as any).updateChannelInfo === "function"
                ) {
                    (window as any).updateChannelInfo(curId);
                }
            } catch (e) {
                console.warn("[Tauri] epg-cache-ready handler failed:", e);
            }
        })
        .catch(function (e: any) {
            console.warn("[Tauri] epg-cache-ready listen failed:", e);
        });
}

/* ---------------------------------------------------------------------------
 * Core channel / media playback
 * --------------------------------------------------------------------------- */

/**
 * Internal implementation of playChannel. Starts playback of the channel
 * at (catIdx, chIdx): validates the category, checks parental access,
 * stops current playback if sStopPlay, updates current channel index,
 * shows channel info, and calls stbPlay() with the channel URL.
 * Also schedules a media check via checkMedia() after 2 seconds.
 *
 * @param catIdx - Category index.
 * @param chIdx - Channel index within the category.
 * @param fullscreen - Close the list after admitting a remote selection.
 * @param admit - Optional current-state guard for a synchronous remote channel step.
 * @param resume - Startup-only local file offset, bound to its source and channel.
 * @param background - Keep the channel list open during natural media transitions.
 * @param fromStart - Start an adjacent media file at zero instead of its saved position.
 *
 * Side effects: Calls stbStop(), setCurrent(), updateChannelInfo(),
 * showChannelInfo(), stbPlay(). Sets window.playType = 0. Creates a
 * setTimeout for checkMedia.
 *
 * Edge case: If the category doesn't exist, shows an error via infoBox()
 * and sendClientFeedback(). If parental access is required, defers via callback.
 */
function _playChannel(
    catIdx: number,
    chIdx: number,
    fullscreen?: boolean,
    admit?: () => boolean,
    resume?: { channelId: string; position: number; sourceId: string },
    background = false,
    fromStart = false
): boolean | void {
    var w = window as any;
    if (w.__ottStandby?.blocked()) return false;
    function resumeCurrent(): boolean {
        return (
            !resume ||
            (w.__ottActiveProviderDriver?.id === "offline" &&
                w.__ottClassicPlayback.sourceId() === resume.sourceId &&
                String((cats[catsArray[catIdx]] || [])[chIdx]) ===
                    resume.channelId &&
                isFinite(resume.position) &&
                resume.position >= 0)
        );
    }
    if (!resumeCurrent()) return false;
    if (admit && !admit()) return false;
    var kiosk = w.__ottKiosk;
    var kioskId = (cats[catsArray[catIdx]] || [])[chIdx];
    if (kiosk && !kiosk.allowed(kioskId)) return;
    if (w.__ottMedia && w.__ottMedia.cancelRequest)
        w.__ottMedia.cancelRequest();
    else if (w.providerMediaClient) w.providerMediaClient.cancel();
    console.log(
        "[playChannel] catIdx=" +
            catIdx +
            " chIdx=" +
            chIdx +
            " catsArray.length=" +
            catsArray.length
    );
    if (catsArray[catIdx] === undefined) {
        infoBox(
            _(
                "ERROR: Category #%1 does not exist!<br>Please select another category.",
                catIdx
            )
        );
        sendClientFeedback(
            "category_trouble_playChannel: " +
                catIdx +
                " / " +
                catsArray.length +
                " / " +
                Object.keys(providerGetJson("cats", {})).length
        );
    }
    var requestedCategory = catsArray[catIdx];
    var requestedId = cats[requestedCategory] && cats[requestedCategory][chIdx];
    if (requestedId == null) return;
    if (admit) {
        // A relative remote step must never leave a PIN continuation that may
        // execute after the request has failed or the channel list has changed.
        if (
            !admit() ||
            !Array.isArray(w.parentalArray) ||
            !w.__ottParental ||
            (w.parentalArray.some(function (id: any) {
                return String(id) === String(requestedId);
            }) &&
                w.__ottParental.needs("channels"))
        )
            return false;
    } else if (
        ifParentalAccessChId(requestedId, function () {
            var category = catsArray.indexOf(requestedCategory);
            var list = cats[requestedCategory];
            var index = list ? list.indexOf(requestedId) : -1;
            if (category >= 0 && index >= 0)
                playChannel(
                    category,
                    index,
                    fullscreen,
                    admit,
                    resume,
                    background,
                    fromStart
                );
        })
    ) {
        console.log("[playChannel] blocked by parental");
        return;
    }
    if (kiosk && !kiosk.admit(requestedId)) return;
    if (fullscreen) {
        // A remote selection commits playback, rather than restoring the preview.
        clearTimeout(w.previewTimer);
        w.previewChan = null;
        if (w.isListVisible) closeList(!admit);
    }
    // Closing a list can run cleanup that changes the provider or local policy.
    if (admit && !admit()) return false;
    // Natural EOF already retired its decoder. Stopping it again would cancel
    // the completion guard before the next Local file can be admitted.
    if (
        settings.stopPlay &&
        !(background && w.__ottClassicPlayback?.snapshot().phase === "stopped")
    )
        stbStop();
    if (admit && !admit()) return false;
    if (!resumeCurrent()) return false;
    setCurrent(catIdx, chIdx);
    if (!resumeCurrent()) return false;
    var channelId = curList[primaryIndex];
    var mediaItem =
        channels[channelId] && (channels[channelId] as any).__ottMediaItem;
    if (mediaItem && w.__ottMedia && w.__ottMedia.playChannel) {
        var selectedDriver = w.__ottActiveProviderDriver;
        var selectedLoad = w.__ottCommandChannelLoad;
        var selectedRow = channels[channelId];
        clearTimeout(w.previewTimer);
        w.previewChan = null;
        if (w.isListVisible && !background) closeList();
        if (
            selectedDriver !== w.__ottActiveProviderDriver ||
            selectedLoad !== w.__ottCommandChannelLoad ||
            selectedRow !== channels[channelId]
        )
            return false;
        return w.__ottMedia.playChannel(
            mediaItem,
            channelId,
            undefined,
            background,
            fromStart
                ? "start"
                : w.commandChannelsReady === false ||
                    (kiosk && kiosk.locked() && kiosk.allowed(channelId))
                  ? "resume"
                  : "prompt"
        );
    }
    console.log(
        "[playChannel] channelId=" +
            channelId +
            " url=" +
            getChannelUrl(channelId)
    );
    if (
        w.__ottClassicPlayback &&
        typeof w.__ottClassicPlayback.command === "function"
    )
        w.__ottClassicPlayback.command({
            channelId: channelId,
            position: resume && resume.position,
            type: "live",
        });
    else w.playType = 0;
    updateChannelInfo(channelId);
    if (settings.infoSwitch) showChannelInfo(settings.infoTimeout);
    if (typeof setPlayer === "function") setPlayer();
    stbPlay(getChannelUrl(channelId), resume && resume.position);
    clearTimeout(w._tmedia);
    w._tmedia = setTimeout(checkMedia, 2000);
    return true;
}

/** Start a resolved MediaRef and render its metadata. The owned media journal chooses resume. */
function _playMedia(item: MediaHistoryEntry, automatic = false): void {
    if ((window as any).__ottStandby?.blocked()) return;
    var kiosk = (window as any).__ottKiosk;
    var channelLaunch =
        (window as any).__ottMedia &&
        (window as any).__ottMedia.channelLaunch &&
        (window as any).__ottMedia.channelLaunch(item);
    if (
        kiosk &&
        kiosk.enabled() &&
        !(
            (channelLaunch != null && kiosk.allowed(channelLaunch)) ||
            (automatic &&
                kiosk.locked() &&
                typeof kiosk.allowedMedia === "function" &&
                kiosk.allowedMedia(item && (item as any).__ottMediaRef))
        )
    )
        return;
    if (!item) return;
    var reference = (item as any).__ottMediaRef;
    if (
        reference &&
        reference.sourceId !== (window as any).__ottMedia.sourceId()
    )
        return;
    if (!automatic) {
        if ((window as any).__ottMedia.cancelRequest)
            (window as any).__ottMedia.cancelRequest();
        else if ((window as any).providerMediaClient)
            (window as any).providerMediaClient.cancel();
    }
    var streamUrl =
        typeof item.stream_url === "function"
            ? item.stream_url()
            : item.stream_url;
    if (typeof streamUrl !== "string" || !streamUrl) return;
    // A delayed live-channel probe must not relabel the newly selected VOD item.
    clearTimeout((window as any)._tmedia);
    clearTimeout(mediaCheckTimer);
    if (channelLaunch == null) setCurrent(catIndex, -1);
    var media = (window as any).__ottMedia.prepare(item, streamUrl);
    if (!media) return;
    item = media.item;
    var resumePos = media.resume;
    var startupPosition = media.resumeStartup ? resumePos : undefined;
    $("#picon").css(
        "background-image",
        'url("' + metadataCssUrl(item.logo_30x30) + '")'
    );
    $("#channel_number").text(" ");
    $("#channel_name").text((window as any).__ottMedia.title(item));
    $("#nprogramm_name").html("&nbsp; ");
    $("#nbegin_time").text("");
    $("#nend_time").text("");
    $("#programm_name").html("&nbsp; ");
    (window as any)._prog100 = 0;
    $("#progress_div").css("background-color", "rgba(68,68,102,0.55)");
    $("#progress_r").css("width", "0%");
    $("#progress").css("width", "0%");
    $("#begin_time").text("");
    $("#end_time").text("");
    $("#programm_name2").text("");
    $("#programm_duration").text("");
    $("#programm_descr").html(getMediaDescr(item));
    if (settings.infoSwitch) showChannelInfo(settings.infoTimeout);
    if (settings.stopPlay) stbStop();
    if (
        (window as any).__ottClassicPlayback &&
        typeof (window as any).__ottClassicPlayback.command === "function"
    )
        (window as any).__ottClassicPlayback.command({
            channelId: media.ref.itemId,
            channelSelection: media.channel && media.channel.id,
            item: item,
            position: startupPosition,
            sourceId: media.ref.sourceId,
            type: "vod",
        });
    stbPlay(streamUrl, startupPosition);
    if (typeof (window as any).__ottClassicPlayback?.programme === "function")
        updateMediaInfo();
    if (resumePos && !media.resumeStartup)
        confirmBox(
            _("Continue watching?") + "<br><br>" + formatSeekOffset(resumePos),
            function () {
                var state = (window as any).__ottClassicPlayback.snapshot();
                if (
                    media.valid() &&
                    state.phase !== "stopped" &&
                    state.target &&
                    state.target.kind === "vod" &&
                    state.target.sourceId === media.ref.sourceId &&
                    state.target.channelId === media.ref.itemId
                )
                    stbSetPosTime(resumePos);
            },
            undefined,
            10000
        );
}

var playChannel = _playChannel;
var playMedia = _playMedia;

window._playChannel = _playChannel;
window.playChannel = playChannel;
window._playMedia = _playMedia;
window.playMedia = playMedia;

window.showFallbackCategoryList = showFallbackCategoryList;
// window.refreshchanelsList = refreshchanelsList; // not yet ported
window.showPage = showPage;
window.closeList = closeList;
window.playPipChannel = playPipChannel;
window.changeSelect = changeSelect;
window.setSelect = setSelect;
window.showShift = showShift;
window.showSelectBox = showSelectBox;
window.infoBox = infoBox;
window.confirmBox = confirmBox;
window.updateChannelInfo = updateChannelInfo;
window.updateMediaInfo = updateMediaInfo;
window.refreshAudioBadge = refreshAudioBadge;
window.stbPlay = stbPlay;
(window as any).captureAspectTarget = captureAspectTarget;
(window as any).captureChannelPreference = captureChannelPreference;
window.stbStop = stbStop;
window.stbPause = stbPause;
window.stbResume = stbResume;
window.stbContinue = stbContinue;
window.stbIsPlaying = stbIsPlaying;
window.stbToggleMute = stbToggleMute;
window.stbGetVolume = stbGetVolume;
window.stbSetVolume = stbSetVolume;
window.stbGetPosTime = stbGetPosTime;
window.stbSetPosTime = stbSetPosTime;
window.stbGetLen = stbGetLen;
window.stbToFullScreen = stbToFullScreen;
window.stbSetWindow = stbSetWindow;
window.stbToggleAspectRatio = stbToggleAspectRatio;

// Tauri Mode B: do NOT wire stbToFullScreen/stbSetWindow to native
// set_fullscreen. Those APIs are in-page video layout (full viewport vs
// small window beside the list). macOS uses simple fullscreen so L and
// Escape still reach the webview. Key L → toggle_fullscreen; Escape →
// set_fullscreen(false) when __ottTauriNativeFs (before exitPortal). No
// global KeyL.

// Native wake locks are a configured device effect, not another transport wrapper.
if (typeof window.__TAURI__ !== "undefined") {
    (window as any).__ottCoreTransport.configure({
        standby: function (standby: boolean) {
            tauriInvoke<any>(
                standby ? "allow_sleep" : "prevent_sleep",
                {}
            ).catch(function (error: any) {
                console.warn("[Tauri] sleep control failed:", error);
            });
        },
    });
}

// Tauri Mode B: player volume only. video.volume is the app source of truth.
// No OS system-volume change — matches commercial OTT behaviour.

/** Read current playback metadata for either native shell at the time of each call. */
function nativeMediaMetadata(): {
    artist: string;
    artworkUrl?: string;
    durationSec?: number;
    positionSec?: number;
    seekable: boolean;
    title: string;
} {
    let title = "OTT-play FOSS";
    let artist = "Now playing";
    let artworkUrl: string | undefined;
    let durationSec: number | undefined;
    let positionSec: number | undefined;
    let seekable = false;
    try {
        const w = window as any;
        const playType = typeof w.playType === "number" ? w.playType : 0;
        const media = playType < 0 && w.__ottMedia && w.__ottMedia.current();
        const movie = (media && media.payload) || {};
        const chName =
            playType < 0
                ? String(movie.title || "")
                : (document.getElementById("channel") as HTMLElement | null)
                      ?.textContent ||
                  (document.getElementById("cname") as HTMLElement | null)
                      ?.textContent ||
                  "";
        if (chName && chName.trim()) title = chName.trim();
        const curList = w.curList;
        const primaryIndex = w.primaryIndex;
        let chId: any;
        if (
            playType >= 0 &&
            Array.isArray(curList) &&
            typeof primaryIndex === "number" &&
            curList[primaryIndex] != null
        ) {
            chId = curList[primaryIndex];
        }
        if (chId != null) {
            if (typeof w.getChannelPicon === "function") {
                const pic = w.getChannelPicon(String(chId));
                if (pic && typeof pic === "string" && pic.trim()) {
                    artworkUrl = pic.trim();
                }
            }
        }
        const ch =
            playType < 0
                ? movie
                : chId != null && w.channels && w.channels[chId];
        if (ch) {
            const icon = ch.icon || ch.logo_30x30 || ch.logo || "";
            if (!artworkUrl && typeof icon === "string" && icon.trim()) {
                artworkUrl = icon.trim();
            }
            if (ch.channel_name && !chName) {
                title = String(ch.channel_name);
            }
        }
        // Live IPTV (playType === 0): not seekable. Archive/VOD only when
        // duration is finite and usable.
        const dur =
            typeof w.stbGetLen === "function" ? Number(w.stbGetLen()) : NaN;
        const pos =
            typeof w.stbGetPosTime === "function"
                ? Number(w.stbGetPosTime())
                : NaN;
        if (playType !== 0 && Number.isFinite(dur) && dur > 0 && dur < 1e7) {
            seekable = true;
            durationSec = dur;
            if (Number.isFinite(pos) && pos >= 0) positionSec = pos;
        }
    } catch (_e) {}
    const out: {
        artist: string;
        artworkUrl?: string;
        durationSec?: number;
        positionSec?: number;
        seekable: boolean;
        title: string;
    } = { artist, seekable, title };
    if (artworkUrl) out.artworkUrl = artworkUrl;
    if (durationSec != null) out.durationSec = durationSec;
    if (positionSec != null) out.positionSec = positionSec;
    return out;
}

// Capacitor Mode C: native media bridges (volume, PiP, fullscreen, standby).
// Mirrors Tauri Mode B shims below; gates on window.Capacitor so Mode A stays untouched.
if (typeof (window as any).Capacitor !== "undefined" && MobileNativeMedia) {
    (function () {
        const cap = MobileNativeMedia;

        const capacitorHost = (window as any).Capacitor;
        const ios =
            typeof capacitorHost.getPlatform === "function" &&
            capacitorHost.getPlatform() === "ios";
        (window as any).__ottCoreTransport.configure({
            fullscreen: function (fullscreen: boolean) {
                cap.setFullscreen({ fullscreen: fullscreen }).catch(function (
                    error: any
                ) {
                    console.warn("[Capacitor] fullscreen failed:", error);
                });
            },
            pip: ios
                ? (window as any).__ottNativePip.create({
                      error: function (error: any) {
                          console.warn("[Capacitor] PiP failed:", error);
                      },
                      invoke: function (action: string, args: any) {
                          return action === "play"
                              ? cap.playPip(args)
                              : cap.stopPip();
                      },
                      prepare: function (
                          args: any,
                          onCancel: (cancel: () => void) => void
                      ) {
                          return new Promise(function (resolve, reject) {
                              var cancel = prepareAccessMedia(
                                  args.url,
                                  function (url) {
                                      resolve(
                                          Object.assign({}, args, { url: url })
                                      );
                                  },
                                  function () {
                                      reject(
                                          new Error("Source sign-in required")
                                      );
                                  }
                              );
                              if (cancel) onCancel(cancel);
                          });
                      },
                      ready: function () {
                          var el = document.getElementById("videopip");
                          if (el) el.style.display = "none";
                      },
                      request: function (url: string) {
                          return {
                              loop: (window as any).ottplayDemoActive === true,
                              subtitle: _("Picture in Picture"),
                              url: url,
                          };
                      },
                      requireOk: true,
                      serial: true,
                  })
                : null,
            prepareSource: ios ? prepareAccessMedia : null,
            standby: function (standby: boolean) {
                (standby ? cap.allowSleep() : cap.preventSleep()).catch(
                    function (error: any) {
                        console.warn(
                            "[Capacitor] sleep control failed:",
                            error
                        );
                    }
                );
            },
            volume: function (volume: number) {
                cap.setVolume({ volume: volume }).catch(function (error: any) {
                    console.warn("[Capacitor] volume failed:", error);
                });
            },
        });

        // WKWebView timers require Window as their receiver, not the ports object.
        (window as any).__ottOsMediaSession.create({
            backend: (window as any).__ottCoreBackend(),
            clearInterval: function (id: number) {
                window.clearInterval(id);
            },
            clearTimeout: function (id: number) {
                window.clearTimeout(id);
            },
            metadata: nativeMediaMetadata,
            send: function (action: string, metadata: any) {
                var method = {
                    pause: "pauseBackgroundAudio",
                    resume: "resumeBackgroundAudio",
                    start: "startBackgroundAudio",
                    stop: "stopBackgroundAudio",
                    update: "updateBackgroundAudio",
                }[action];
                (cap as any)[method!](metadata).catch(function (error: any) {
                    console.warn("[Capacitor] media session failed:", error);
                });
            },
            setInterval: function (callback: () => void, delay: number) {
                return window.setInterval(callback, delay);
            },
            setTimeout: function (callback: () => void, delay: number) {
                return window.setTimeout(callback, delay);
            },
        });
    })();
}

// Tauri Mode B: OS MediaSession / MPRIS / Now Playing (souvlaki) — lock-screen style
// transport + artwork/seek when souvlaki + duration allow. Cap path unchanged; Mode A unchanged.
if (typeof window.__TAURI__ !== "undefined") {
    (window as any).__ottOsMediaSession.create({
        backend: (window as any).__ottCoreBackend(),
        clearInterval: function (id: number) {
            window.clearInterval(id);
        },
        clearTimeout: function (id: number) {
            window.clearTimeout(id);
        },
        metadata: nativeMediaMetadata,
        send: function (action: string, metadata: any) {
            var method = {
                pause: "pause_media_session",
                resume: "resume_media_session",
                start: "start_media_session",
                stop: "stop_media_session",
                update: "update_media_session",
            }[action];
            tauriInvoke<any>(method!, metadata).catch(function (error: any) {
                console.warn("[Tauri] media session failed:", error);
            });
        },
        setInterval: function (callback: () => void, delay: number) {
            return window.setInterval(callback, delay);
        },
        setTimeout: function (callback: () => void, delay: number) {
            return window.setTimeout(callback, delay);
        },
    });
}

// Tauri Mode B: frameless window — JS whole-surface drag when overlays closed.
// decorations:false removes the system title bar; without a drag region the
// window cannot be moved. Gate on __TAURI__ so Chrome companion is unchanged.
// Nuclear rule: NEVER put -webkit-app-region:drag or data-tauri-drag-region on
// #listCaption / body / html / list chrome. Never CSS body/html drag while
// Menu / Channel list / listEdit are open (rows must keep pointer hits).
//
// Critical (macOS WKWebView / Tauri):
// 1) Do NOT set -webkit-app-region:drag on strip/body — WebKit swallows mousedown
//    so neither Tauri's data-tauri-drag-region handler nor our startDragging runs.
// 2) Do NOT rely solely on hit-testing the strip element. Native <video> layers
//    often composite ABOVE HTML regardless of z-index, so mousedown lands on
//    #video/#launch. Fix: capture-phase mousedown on document when overlays are
//    closed → pending startDragging on empty chrome/video (NOT CSS body drag),
//    except interactive controls in NO_DRAG_SEL. Top ~36px strip stays a visual
//    affordance; drag works across the whole empty plane.
// Do not use $("#list").is(":visible") — #list has no CSS display:none, so after
// showPage clears inline style it stays :visible and falsely hides the strip.
if (typeof window.__TAURI__ !== "undefined") {
    setupTauriEpgOverride();
    setupTauriEpgCacheReady();
    setupTauriCompanionShim();
    (function () {
        const CLASS = "ott-tauri-frameless";
        const OVERLAY_CLASS = "ott-tauri-overlay-open";
        const STYLE_ID = "ott-tauri-frameless-drag";
        const STRIP_ID = "ott-tauri-drag-strip";
        // Thick enough to find; subtle fill so it is not invisible chrome.
        const STRIP_H = 36;
        // Interactive / overlay surfaces that must keep pointer clicks.
        // #list / #listCaption / rows must never be CSS or JS drag handles.
        // NOTE: #video/#launch are intentionally NOT in this blocklist —
        // WKWebView video often sits above HTML; whole-surface drag must reach them.
        const NO_DRAG_SEL =
            "#list,#listCaption,#listIn,#listAbout,#listEdit,#listPopUp,#listDetail,#listPodval," +
            "#list_osd,#list_window,.osd,#info,#info1,#numprog,#dialogbox,#volume_div,#mute," +
            "#permanentTime,#notifications,#buffering,#pip_buffering,#videopip," +
            "#progress_div,#progress,#progress_r,#progress_span,#descr,#channel,#data," +
            '#ott-tauri-loading-logs,.item,[id^="it"],.list-scroll,' +
            'button,input,select,textarea,a,.btn,.osk-key,[role="button"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],[contenteditable="true"]';
        const DRAG_SEL = "#" + STRIP_ID;
        // Empty chrome / video surfaces that may start a window drag when
        // overlays are closed (never list/menu chrome — those are in NO_DRAG_SEL).
        const SURFACE_OK_SEL =
            "#video,#vdiv,#launch,#ott-tauri-drag-strip,body,html";

        document.documentElement.classList.add(CLASS);
        if (document.body) document.body.classList.add(CLASS);

        const ensureDragStrip = (): HTMLElement | null => {
            let strip = document.getElementById(STRIP_ID);
            if (strip) return strip;
            if (!document.body) return null;
            strip = document.createElement("div");
            strip.id = STRIP_ID;
            strip.setAttribute("aria-hidden", "true");
            // Created before the language script; resolve the tooltip on hover.
            strip.addEventListener("mouseenter", function () {
                if (strip) strip.title = _("Drag window");
            });
            document.body.appendChild(strip);
            return strip;
        };
        ensureDragStrip();

        // CSS: html/body/list chrome always no-drag. Strip is also no-drag so
        // WKWebView delivers mousedown; our startDragging moves the window.
        // Subtle visible top chrome so the handle is discoverable.
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            const noDragCss = NO_DRAG_SEL.split(",")
                .map((s) => "html." + CLASS + " " + s.trim())
                .join(",\n");
            style.textContent =
                "html." +
                CLASS +
                ", html." +
                CLASS +
                " body {\n  -webkit-app-region: no-drag !important;\n  app-region: no-drag !important;\n}\n" +
                "html." +
                CLASS +
                " #list,\nhtml." +
                CLASS +
                " #listIn,\nhtml." +
                CLASS +
                " #listCaption,\nhtml." +
                CLASS +
                " .item,\nhtml." +
                CLASS +
                ' [id^="it"] {\n  -webkit-app-region: no-drag !important;\n  app-region: no-drag !important;\n}\n' +
                "#" +
                STRIP_ID +
                " {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  height: " +
                STRIP_H +
                "px;\n  z-index: 2147483000;\n  pointer-events: auto;\n  cursor: grab;\n" +
                "  background: linear-gradient(to bottom, rgba(0,0,0,0.45), rgba(0,0,0,0.18) 70%, transparent);\n" +
                "  border-bottom: 1px solid rgba(255,255,255,0.08);\n" +
                "  -webkit-app-region: no-drag !important;\n  app-region: no-drag !important;\n}\n" +
                "html." +
                CLASS +
                "." +
                OVERLAY_CLASS +
                " #" +
                STRIP_ID +
                " {\n  display: none !important;\n  -webkit-app-region: no-drag !important;\n  app-region: no-drag !important;\n  pointer-events: none !important;\n}\n" +
                noDragCss +
                " {\n  -webkit-app-region: no-drag !important;\n  app-region: no-drag !important;\n}\n";
            document.head.appendChild(style);
        }

        const listOverlayOpen = (): boolean => {
            try {
                // DOM visibility only — never $("#list"):visible (sticky) and
                // never bare isListVisible (can disagree with hidden overlays).
                if (typeof $ === "undefined") return false;
                return (
                    $("#list_window").is(":visible") ||
                    $("#list_osd").is(":visible") ||
                    $("#listEdit").is(":visible")
                );
            } catch (_e) {
                return false;
            }
        };

        const forceNoDragEl = (el: HTMLElement | null | undefined): void => {
            if (!el) return;
            el.style.setProperty("-webkit-app-region", "no-drag", "important");
            el.style.setProperty("app-region", "no-drag", "important");
            el.removeAttribute("data-tauri-drag-region");
        };

        // Sync strip drag state. Caption/body/html never get drag or the
        // data-tauri-drag-region attribute. Strip stays no-drag CSS + attribute.
        const syncBodyDragRegion = (): void => {
            const open = listOverlayOpen();
            const html = document.documentElement;
            const body = document.body;
            const strip = ensureDragStrip();
            if (html) {
                forceNoDragEl(html);
                html.classList.toggle(OVERLAY_CLASS, open);
            }
            forceNoDragEl(body);
            forceNoDragEl(document.getElementById("listCaption"));
            forceNoDragEl(document.getElementById("list"));
            forceNoDragEl(document.getElementById("listIn"));
            forceNoDragEl(document.getElementById("listEdit"));
            if (open) {
                // Never leave a stuck click-suppress while the menu is open.
                (window as any).__ottTauriSuppressClick = false;
            }
            // Native <video> often sits above HTML regardless of z-index; while
            // Channel list / OSD is open, disable hit-testing so footer buttons
            // and rows receive clicks.
            try {
                for (const id of ["video", "vdiv", "videopip"]) {
                    const el = document.getElementById(id);
                    if (!el) continue;
                    if (open) {
                        el.style.setProperty(
                            "pointer-events",
                            "none",
                            "important"
                        );
                    } else {
                        el.style.removeProperty("pointer-events");
                    }
                }
            } catch (_pe) {}
            if (strip) {
                if (open || (window as any).__ottTauriNativeFs) {
                    strip.style.display = "none";
                    strip.style.setProperty(
                        "-webkit-app-region",
                        "no-drag",
                        "important"
                    );
                    strip.style.setProperty(
                        "app-region",
                        "no-drag",
                        "important"
                    );
                    strip.style.setProperty(
                        "pointer-events",
                        "none",
                        "important"
                    );
                    strip.removeAttribute("data-tauri-drag-region");
                } else {
                    strip.style.display = "";
                    strip.style.height = STRIP_H + "px";
                    // Keep no-drag so mousedown reaches JS (Tauri drag.js + us).
                    strip.style.setProperty(
                        "-webkit-app-region",
                        "no-drag",
                        "important"
                    );
                    strip.style.setProperty(
                        "app-region",
                        "no-drag",
                        "important"
                    );
                    strip.style.setProperty(
                        "pointer-events",
                        "auto",
                        "important"
                    );
                    strip.setAttribute("data-tauri-drag-region", "");
                }
            }
        };
        syncBodyDragRegion();
        try {
            window.setInterval(syncBodyDragRegion, 250);
        } catch (_e) {}

        const markNoDrag = (root: ParentNode) => {
            root.querySelectorAll(NO_DRAG_SEL).forEach((el) => {
                (el as HTMLElement).style.setProperty(
                    "-webkit-app-region",
                    "no-drag",
                    "important"
                );
                (el as HTMLElement).style.setProperty(
                    "app-region",
                    "no-drag",
                    "important"
                );
                (el as HTMLElement).removeAttribute("data-tauri-drag-region");
            });
        };
        markNoDrag(document);
        try {
            const mo = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    m.addedNodes.forEach((n) => {
                        if (n.nodeType !== 1) return;
                        const el = n as HTMLElement;
                        if (el.id === STRIP_ID) return;
                        if (el.matches?.(NO_DRAG_SEL)) {
                            el.style.setProperty(
                                "-webkit-app-region",
                                "no-drag",
                                "important"
                            );
                            el.style.setProperty(
                                "app-region",
                                "no-drag",
                                "important"
                            );
                            el.removeAttribute("data-tauri-drag-region");
                        }
                        markNoDrag(el);
                    });
                }
            });
            mo.observe(document.documentElement, {
                childList: true,
                subtree: true,
            });
        } catch (_e) {}

        const startDragging = (): void => {
            // Prefer getCurrentWindow().startDragging() (Tauri 2 public API),
            // then internals invoke (what drag.js uses), then core invoke.
            const tryPaths: Array<() => Promise<unknown> | void> = [
                () => {
                    const tw = (window as any).__TAURI__?.window;
                    const cur =
                        typeof tw?.getCurrentWindow === "function"
                            ? tw.getCurrentWindow()
                            : null;
                    if (cur && typeof cur.startDragging === "function") {
                        return cur.startDragging();
                    }
                    throw new Error("no getCurrentWindow().startDragging");
                },
                () => {
                    const internals = (window as any).__TAURI_INTERNALS__;
                    if (internals && typeof internals.invoke === "function") {
                        return internals.invoke("plugin:window|start_dragging");
                    }
                    throw new Error("no __TAURI_INTERNALS__.invoke");
                },
                () => {
                    const core = (window as any).__TAURI__?.core;
                    if (core && typeof core.invoke === "function") {
                        return core.invoke("plugin:window|start_dragging");
                    }
                    throw new Error("no __TAURI__.core.invoke");
                },
                () => tauriInvoke<any>("plugin:window|start_dragging", {}),
                () => tauriInvoke<any>("start_dragging", {}),
            ];
            (async () => {
                for (const fn of tryPaths) {
                    try {
                        await Promise.resolve(fn());
                        return;
                    } catch (e) {
                        try {
                            console.warn(
                                "[Tauri] startDragging path failed:",
                                e
                            );
                        } catch (_e) {}
                    }
                }
                try {
                    console.warn("[Tauri] all startDragging paths failed");
                } catch (_e) {}
            })();
        };

        // JS drag from empty plane (strip + chrome + #video), overlays closed.
        // Never CSS -webkit-app-region:drag on body — overlays must keep row hits.
        // Bottom info band (body_onClick → showChannelInfo) is not a drag handle;
        // mousedown-preventDefault there would kill the click.
        // Prefer viewport height (innerHeight / visualViewport), not body rect —
        // an oversized body mapped clicks in the bottom band to ENTER.
        const isDragHandle = (t: Element, clientY: number): boolean => {
            if ((window as any).__ottTauriNativeFs) return false;
            if (listOverlayOpen()) return false;
            // Never drag from list/menu chrome or form controls.
            if (t.closest(NO_DRAG_SEL)) return false;
            try {
                const h = ottBandViewportHeight();
                if (
                    h > 0 &&
                    typeof clientY === "number" &&
                    clientY > ottBottomInfoBandStart(h)
                ) {
                    return false;
                }
            } catch (_band) {}
            if (t.id === STRIP_ID) return true;
            if (t.closest(DRAG_SEL)) return true;
            // Whole empty surface: allow even when target is #video/#launch.
            if (t.closest(SURFACE_OK_SEL) || t === document.body) return true;
            if (t === document.documentElement) return true;
            const tag = (t as HTMLElement).tagName;
            if (tag === "VIDEO" || tag === "BODY" || tag === "HTML")
                return true;
            // Non-interactive DIV chrome outside NO_DRAG_SEL.
            if (tag === "DIV") return true;
            return false;
        };

        let startedNativeDrag = false;
        let suppressTimer: ReturnType<typeof setTimeout> | null = null;
        // Pending surface mousedown: only call startDragging after a small
        // movement so a stationary click still reaches body.onclick (Menu /
        // ENTER / info). Top strip presses also arm click-suppress immediately
        // so a barely-moved grab does not open Menu via the top 20% band.
        let pendingChromeDown: {
            x: number;
            y: number;
            strip: boolean;
        } | null = null;
        const DRAG_MOVE_PX = 4;

        const armSuppressClick = (): void => {
            (window as any).__ottTauriSuppressClick = true;
            if (suppressTimer != null) {
                try {
                    window.clearTimeout(suppressTimer);
                } catch (_e) {}
            }
            // Long enough to cover mouseup→click after a failed/short drag.
            suppressTimer = window.setTimeout(() => {
                (window as any).__ottTauriSuppressClick = false;
                suppressTimer = null;
            }, 750);
        };

        const clearPendingChrome = (): void => {
            pendingChromeDown = null;
            startedNativeDrag = false;
        };

        document.addEventListener(
            "mousedown",
            (ev: MouseEvent) => {
                if (ev.button !== 0) return;
                const t = ev.target;
                if (!(t instanceof Element)) return;
                syncBodyDragRegion();
                clearPendingChrome();
                if (!isDragHandle(t, ev.clientY)) return;
                const onStrip =
                    t.id === STRIP_ID ||
                    !!t.closest(DRAG_SEL) ||
                    (typeof ev.clientY === "number" &&
                        ev.clientY >= 0 &&
                        ev.clientY < STRIP_H);
                pendingChromeDown = {
                    strip: onStrip,
                    x: ev.clientX,
                    y: ev.clientY,
                };
                // Strip/top band: arm suppress immediately (top 20% → Menu).
                // Rest of plane: suppress only after a real drag starts.
                if (onStrip) armSuppressClick();
                // Do not startDragging yet — wait for small movement.
                // Do NOT preventDefault here: WKWebView suppresses the following
                // click after mousedown.preventDefault, which killed bottom-band
                // showChannelInfo / middle ENTER. preventDefault only when drag starts.
                // Do not stopImmediatePropagation — Tauri's drag.js also listens.
            },
            true
        );

        document.addEventListener(
            "mousemove",
            (ev: MouseEvent) => {
                if (!pendingChromeDown || startedNativeDrag) return;
                if (ev.buttons !== undefined && (ev.buttons & 1) === 0) {
                    // Button released without our mouseup (OS steal) — keep suppress.
                    armSuppressClick();
                    clearPendingChrome();
                    return;
                }
                const dx = ev.clientX - pendingChromeDown.x;
                const dy = ev.clientY - pendingChromeDown.y;
                if (dx * dx + dy * dy < DRAG_MOVE_PX * DRAG_MOVE_PX) return;
                startedNativeDrag = true;
                armSuppressClick();
                try {
                    ev.preventDefault();
                } catch (_pd) {}
                startDragging();
            },
            true
        );

        document.addEventListener(
            "mouseup",
            (ev: MouseEvent) => {
                // Suppress Menu after a real drag, or after a top-strip press
                // (even if the pointer barely moved). Plain clicks elsewhere
                // on the empty plane must still open Menu / ENTER / info.
                if (
                    startedNativeDrag ||
                    (pendingChromeDown && pendingChromeDown.strip)
                ) {
                    armSuppressClick();
                    clearPendingChrome();
                    return;
                }
                // WKWebView <video> may fire mousedown/mouseup but never deliver
                // a bubbled click to body.onclick. Bottom-band mouseup → info bar
                // when overlays are closed and this was not a drag/strip press.
                try {
                    if (
                        ev.button === 0 &&
                        !listOverlayOpen() &&
                        !(window as any).__ottTauriSuppressClick
                    ) {
                        const raw = ev.target;
                        if (!(raw instanceof Element)) {
                            clearPendingChrome();
                            return;
                        }
                        const el = raw;
                        const onVideoSurface =
                            el.tagName === "VIDEO" ||
                            !!el.closest("#video,#vdiv,#launch") ||
                            el === document.body ||
                            el === document.documentElement;
                        if (onVideoSurface && !el.closest(NO_DRAG_SEL)) {
                            const h = ottBandViewportHeight();
                            if (
                                h > 0 &&
                                typeof ev.clientY === "number" &&
                                ev.clientY > ottBottomInfoBandStart(h)
                            ) {
                                (window as any).__ottInfoBandFromMouseUp = true;
                                try {
                                    ev.preventDefault();
                                    ev.stopPropagation();
                                    ev.stopImmediatePropagation();
                                } catch (_sp) {}
                                try {
                                    if (
                                        typeof (window as any)
                                            .showChannelInfo === "function"
                                    ) {
                                        (window as any).showChannelInfo();
                                    }
                                } catch (_sci) {}
                                // Race-safe: clear after click window, not only setTimeout 0.
                                window.setTimeout(() => {
                                    (window as any).__ottInfoBandFromMouseUp =
                                        false;
                                }, 400);
                            }
                        }
                    }
                } catch (_muInfo) {}
                clearPendingChrome();
            },
            true
        );

        // Capture-phase click kill after a surface drag / strip press only.
        document.addEventListener(
            "click",
            (ev: MouseEvent) => {
                if (!(window as any).__ottTauriSuppressClick) return;
                // Never kill clicks inside list chrome even if suppress stuck.
                const t = ev.target;
                if (t instanceof Element) {
                    if (
                        t.closest(
                            '#list,#listIn,#listEdit,.item,[id^="it"],#listCaption,#listPodval'
                        )
                    ) {
                        (window as any).__ottTauriSuppressClick = false;
                        return;
                    }
                }
                ev.preventDefault();
                ev.stopPropagation();
                ev.stopImmediatePropagation();
                (window as any).__ottTauriSuppressClick = false;
                if (suppressTimer != null) {
                    try {
                        window.clearTimeout(suppressTimer);
                    } catch (_e) {}
                    suppressTimer = null;
                }
            },
            true
        );

        // WKWebView <video>/#vdiv often does not bubble click to body.onclick.
        // Capture on the video surface and run the same band logic as
        // key-handler body_onClick; stopPropagation avoids double-fire when
        // the event does bubble. List-open footer stays safe via overlay guard
        // + pointer-events:none on video while the list is open.
        document.addEventListener(
            "click",
            (ev: MouseEvent) => {
                if ((window as any).__ottTauriSuppressClick) return;
                if ((window as any).__ottInfoBandFromMouseUp) return;
                if (listOverlayOpen()) return;
                const target = ev.target;
                if (!(target instanceof Element)) return;
                if (
                    target.tagName !== "VIDEO" &&
                    !target.closest("#video,#vdiv,#launch")
                ) {
                    return;
                }
                if (target.closest(NO_DRAG_SEL)) return;
                if (typeof ev.clientY !== "number") return;
                const h = ottBandViewportHeight();
                if (!(h > 0)) return;
                try {
                    if (ev.clientY < h * 0.2) {
                        if (typeof (window as any).popupList === "function") {
                            (window as any).popupList();
                        }
                        ev.stopPropagation();
                    } else if (ev.clientY > ottBottomInfoBandStart(h)) {
                        if (
                            typeof (window as any).showChannelInfo ===
                            "function"
                        ) {
                            (window as any).showChannelInfo();
                        }
                        // Stop ENTER / body_onClick from also firing.
                        ev.preventDefault();
                        ev.stopPropagation();
                        ev.stopImmediatePropagation();
                    } else if (
                        typeof (window as any)._doKey === "function" &&
                        (window as any).keys
                    ) {
                        (window as any)._doKey((window as any).keys.ENTER, ev);
                        ev.stopPropagation();
                    }
                } catch (_capBand) {}
            },
            true
        );
    })();
}

// Tauri Mode B: if the #launch Loading screen stays up ≥20s, show a side panel
// with a recent console / [Tauri] log tail — polite diagnostics, not an infinite
// blank spinner. Mode A / Chrome companion unchanged (gated on __TAURI__).
if (typeof window.__TAURI__ !== "undefined") {
    (function setupTauriLoadingLogPanel() {
        const MAX_LINES = 120;
        const DELAY_MS = 20_000;
        const PANEL_ID = "ott-tauri-loading-logs";
        const STYLE_ID = "ott-tauri-loading-logs-style";
        const lines: string[] = [];
        let visibleSince: number | null = null;
        let showTimer: ReturnType<typeof setTimeout> | null = null;
        let panel: HTMLElement | null = null;
        let preEl: HTMLPreElement | null = null;
        let rafPending = false;

        function formatArg(a: unknown): string {
            if (a == null) return String(a);
            if (typeof a === "string") return a;
            if (typeof a === "number" || typeof a === "boolean")
                return String(a);
            if (a instanceof Error) {
                return a.stack || a.message || String(a);
            }
            try {
                return JSON.stringify(a);
            } catch (_e) {
                try {
                    return String(a);
                } catch (_e2) {
                    return "[unprintable]";
                }
            }
        }

        function pad2(n: number): string {
            return (n < 10 ? "0" : "") + n;
        }

        function stamp(): string {
            const d = new Date();
            return (
                pad2(d.getHours()) +
                ":" +
                pad2(d.getMinutes()) +
                ":" +
                pad2(d.getSeconds())
            );
        }

        function pushLine(level: string, args: unknown[]): void {
            const body = args.map(formatArg).join(" ");
            lines.push("[" + stamp() + "] " + level + " " + body);
            if (lines.length > MAX_LINES) {
                lines.splice(0, lines.length - MAX_LINES);
            }
            if (panel && panel.style.display !== "none" && preEl) {
                if (rafPending) return;
                rafPending = true;
                requestAnimationFrame(() => {
                    rafPending = false;
                    if (!preEl) return;
                    preEl.textContent = lines.join("\n");
                    preEl.scrollTop = preEl.scrollHeight;
                });
            }
        }

        function wrapConsole(): void {
            (["log", "warn", "error"] as const).forEach((level) => {
                const orig = console[level].bind(console);
                console[level] = (...args: unknown[]) => {
                    try {
                        pushLine(level, args);
                    } catch (_e) {
                        /* never break logging */
                    }
                    return orig(...args);
                };
            });
        }

        function ensureStyles(): void {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent =
                "#" +
                PANEL_ID +
                " {\n" +
                "  position: fixed;\n" +
                "  top: 0;\n" +
                "  right: 0;\n" +
                "  bottom: 0;\n" +
                "  width: min(42vw, 420px);\n" +
                "  z-index: 2147483000;\n" +
                "  display: none;\n" +
                "  flex-direction: column;\n" +
                "  box-sizing: border-box;\n" +
                "  padding: 10px 12px 12px;\n" +
                "  background: rgba(8, 10, 14, 0.82);\n" +
                "  color: #c8d0d8;\n" +
                "  border-left: 1px solid rgba(255, 255, 255, 0.12);\n" +
                "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n" +
                "  font-size: 11px;\n" +
                "  line-height: 1.35;\n" +
                "  -webkit-app-region: no-drag;\n" +
                "  pointer-events: auto;\n" +
                "}\n" +
                "#" +
                PANEL_ID +
                " .ott-tauri-ll-title {\n" +
                "  flex: 0 0 auto;\n" +
                "  margin: 0 0 8px;\n" +
                "  color: #f0c040;\n" +
                "  font-size: 12px;\n" +
                "  letter-spacing: 0.02em;\n" +
                "  -webkit-app-region: no-drag;\n" +
                "}\n" +
                "#" +
                PANEL_ID +
                " .ott-tauri-ll-pre {\n" +
                "  flex: 1 1 auto;\n" +
                "  margin: 0;\n" +
                "  padding: 0;\n" +
                "  overflow: auto;\n" +
                "  white-space: pre-wrap;\n" +
                "  word-break: break-word;\n" +
                "  color: #b8c0c8;\n" +
                "  background: transparent;\n" +
                "  -webkit-app-region: no-drag;\n" +
                "}\n";
            (document.head || document.documentElement).appendChild(style);
        }

        function ensurePanel(): void {
            ensureStyles();
            panel = document.getElementById(PANEL_ID) as HTMLElement | null;
            if (panel) {
                preEl = panel.querySelector(
                    ".ott-tauri-ll-pre"
                ) as HTMLPreElement | null;
                return;
            }
            panel = document.createElement("div");
            panel.id = PANEL_ID;
            panel.setAttribute("role", "complementary");
            panel.setAttribute("aria-label", "Loading diagnostics");
            panel.style.setProperty("-webkit-app-region", "no-drag");

            const title = document.createElement("div");
            title.className = "ott-tauri-ll-title";
            title.textContent =
                "Still loading — recent logs (Tauri diagnostics)";

            preEl = document.createElement("pre");
            preEl.className = "ott-tauri-ll-pre";

            panel.appendChild(title);
            panel.appendChild(preEl);
            (document.body || document.documentElement).appendChild(panel);
        }

        function showPanel(): void {
            ensurePanel();
            if (!panel || !preEl) return;
            panel.style.display = "flex";
            preEl.textContent = lines.join("\n");
            preEl.scrollTop = preEl.scrollHeight;
        }

        function hidePanel(): void {
            if (panel) panel.style.display = "none";
        }

        function isLaunchLoading(): boolean {
            const el = document.getElementById("launch");
            if (!el) return false;
            if (el.getAttribute("data-done") === "1") return false;
            // jQuery .hide() / inline display:none
            if (el.style.display === "none") return false;
            try {
                const cs = window.getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") {
                    return false;
                }
                // Off-screen / zero-size counts as gone
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
            } catch (_e) {
                return el.style.display !== "none";
            }
            return true;
        }

        function clearShowTimer(): void {
            if (showTimer != null) {
                clearTimeout(showTimer);
                showTimer = null;
            }
        }

        function syncFromLaunch(): void {
            if (isLaunchLoading()) {
                if (visibleSince == null) visibleSince = Date.now();
                const elapsed = Date.now() - visibleSince;
                if (elapsed >= DELAY_MS) {
                    clearShowTimer();
                    showPanel();
                    return;
                }
                if (showTimer == null) {
                    showTimer = setTimeout(() => {
                        showTimer = null;
                        if (isLaunchLoading()) showPanel();
                    }, DELAY_MS - elapsed);
                }
            } else {
                visibleSince = null;
                clearShowTimer();
                hidePanel();
            }
        }

        wrapConsole();
        pushLine("log", ["[Tauri] loading log panel armed (shows after 20s)"]);

        const arm = (): void => {
            syncFromLaunch();
            const launch = document.getElementById("launch");
            if (launch) {
                try {
                    const mo = new MutationObserver(() => syncFromLaunch());
                    mo.observe(launch, {
                        attributeFilter: [
                            "style",
                            "class",
                            "data-done",
                            "hidden",
                        ],
                        attributes: true,
                        childList: true,
                        subtree: true,
                    });
                } catch (_e) {}
            }
            // Style changes via CSS / jQuery may not always fire; light poll.
            setInterval(syncFromLaunch, 1000);
        };

        if (document.body) arm();
        else
            document.addEventListener("DOMContentLoaded", arm, {
                once: true,
            });
    })();
}

window.stbToggleAudioTrack = stbToggleAudioTrack;
window.stbToggleSubtitle = stbToggleSubtitle;
window.stbAudioTracksExists = stbAudioTracksExists;
window.stbSubtitleExists = stbSubtitleExists;
window.stbPlayPip = stbPlayPip;
window.stbStopPip = stbStopPip;

window.stbSetBuffer = stbSetBuffer;
/**
 * Generic settings-list setup function. Assigned to window._setSetup.
 * Renders a list of setting items with current values and left/right
 * arrows to change them, a GREEN/PLAY button to save, and RETURN to cancel.
 *
 * @param saveCallback - Function called when the user saves settings.
 * @param cancelCallback - Function called when the user cancels.
 *
 * Side effects: Overrides window.selIndex, getListItem, detailListAction,
 * listKeyHandlerFn, listDataArray; writes to #listDetail, #listPodval;
 * calls showPage().
 */
window._setSetup = function (
    saveCallback: () => void,
    cancelCallback: () => void
): void {
    var w = window as any;
    w.selIndex = 0;
    w.getListItem = function (item: any, _idx: number): string {
        // Name|value must be flex children with INLINE styles. Class-only
        // .item-label/.item-value fails in Tauri/WKWebView when player.css is
        // late/missing/stale; :8443 looked "formatted" because the old markup
        // used inline width:23%/75% (floats are ignored under .item{display:flex}).
        // Same pattern as showPage()'s inline display:flex on .item.
        var labelStyle =
            "flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
            "white-space:nowrap;line-height:normal;";
        var valueStyle =
            "flex:0 0 auto;max-width:42%;margin-left:auto;overflow:hidden;" +
            "text-overflow:ellipsis;white-space:nowrap;line-height:normal;" +
            "text-align:right;";
        return (
            '<div class="item-label" style="' +
            labelStyle +
            '">&nbsp;&nbsp;' +
            item.name +
            "</div>" +
            '<div class="item-value" style="' +
            valueStyle +
            '">' +
            (item.values[item.val] || item.cur) +
            "&nbsp;&nbsp;</div>"
        );
    };
    var detailEl = document.getElementById("listDetail");
    if (detailEl) detailEl.innerHTML = "";
    w.detailListAction = function (): void {
        var item = w.listArray[w.selIndex];
        var dEl = document.getElementById("listDetail");
        if (dEl) {
            dEl.innerHTML =
                (Array.isArray(item.values)
                    ? item.name +
                      "<br/><br/>" +
                      (w._("Choose from") || "Choose from") +
                      ":<br/>" +
                      item.values
                          .filter(function (v: any) {
                              return v !== "@@@";
                          })
                          .join(", ")
                    : item.cur) + (item.desc ? "<br/><br/>" + item.desc : "");
        }
    };
    var footerElement = document.getElementById("listPodval");
    if (footerElement) {
        footerElement.innerHTML =
            w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
            w.renderButtonHint(
                w.keys.ENTER,
                w.strENTER,
                "Change value",
                w.strLEFT,
                w.strRIGHT
            ) +
            w.renderButtonHint(
                w.keys.GREEN,
                "",
                "Save Settings",
                w.strPlayPause,
                "0"
            );
    }
    w.listKeyHandlerFn = function (e: number): boolean {
        var item = w.listArray[w.selIndex];
        switch (e) {
            case w.keys.ENTER:
                if (typeof item.values === "function") {
                    item.values();
                }
                if (Array.isArray(item.values) && item.values.length > 2) {
                    w.selectValue(item);
                    return true;
                }
            case w.keys.RIGHT:
                if (Array.isArray(item.values)) {
                    item.val =
                        item.val > item.values.length - 2 ? 0 : item.val + 1;
                    if (item.values[item.val] === "@@@") {
                        w.listKeyHandlerFn(e);
                    } else if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            case w.keys.LEFT:
                if (Array.isArray(item.values)) {
                    item.val =
                        item.val === 0 ? item.values.length - 1 : item.val - 1;
                    if (item.values[item.val] === "@@@") {
                        w.listKeyHandlerFn(e);
                    } else if (typeof w.showPage === "function") w.showPage();
                }
                return true;
            case w.keys.N0:
            case w.keys.PLAY:
            case w.keys.PAUSE:
            case w.keys.GREEN:
                saveCallback();
                return true;
            case w.keys.RETURN:
                cancelCallback();
                return true;
        }
        return false;
    };
    w.listDataArray = w.listArray;
    if (typeof w.showPage === "function") w.showPage();
};

/**
 * Show the "STB Settings" screen (editor, player mode, buffer size).
 * Checks parental PIN (sPSoptions), renders a list with save callback,
 * and persists changes to storage on save.
 *
 * A source-bound draft commits stable setting IDs to the appropriate scope.
 *
 * Side effects: Calls setEditor(), stbSetBuffer(), showShift(), closeList();
 * writes to stb storage.
 */
window.stbOptions = function (): void {
    var w = window as any;
    var showPlayerChoice =
        w.ott_device !== "lg/webos" &&
        !(w.ott_device === "pc2" && typeof w.videojs === "function");
    if (w.__ottParental.needs("settings")) {
        if (typeof w.enterPinAndSetAccess === "function")
            w.enterPinAndSetAccess(w.stbOptions);
        return;
    }
    /**
     * Persist the STB settings (editor, player mode, buffer size) and
     * re-apply them. Then re-open the stbOptions screen.
     */
    var page = createSettingsPage(w, "stbOptions", "Settings STB", true, true);
    var choice = page.choice;
    var label = page.label;

    var noyes = [label("no"), label("yes")];
    setListArrays(
        w,
        page.rows([
            choice(label("Editor"), "editor", w.sEditor, [
                label("built-in"),
                label("native"),
            ]),
            choice(
                label("Type of player for streaming"),
                "players",
                w.sPlayers,
                w.playerModeNames
            ),
            choice(
                label("Buffer Size, s"),
                "bufSize",
                w.sBufSize,
                w.bufferSizes
            ),
        ])
    );
    if (!showPlayerChoice)
        setListArrays(
            w,
            w.listArray.filter(function (row: any) {
                return row.settingId !== "players";
            })
        );
    page.attach();
};
delete (window as any).addAoptions;

/** Dual-write listArray + listDataArray to window. Used by settings screens. */
function setListArrays(w: any, data: any[]): void {
    w.listArray = data;
    w.listDataArray = data;
}

/** Settings screens share one draft lifecycle after their rows are filtered. */
function createSettingsPage(
    w: any,
    menu: string,
    caption: string,
    closeAfterSave: boolean,
    reopenStb: boolean
) {
    var editor: any;
    function label(text: string): string {
        return w._(text) || text;
    }
    function back() {
        if (reopenStb) w.stbOptions();
        else w.optionsList(w[menu]);
    }
    function save() {
        if (!editor.save()) return;
        if (typeof w.showShift === "function")
            w.showShift(label("Settings saved"));
        if (closeAfterSave && typeof w.closeList === "function") w.closeList();
        back();
    }
    function saveSettings() {
        save();
    }
    var saveCallback = reopenStb ? saveSettings : save;
    return {
        attach: function () {
            editor = createSettingsEditor(w, w.listArray);
            var cap = document.getElementById("listCaption");
            if (cap) cap.innerHTML = label(caption);
            if (typeof w._setSetup === "function")
                w._setSetup(saveCallback, function () {
                    editor.cancel();
                    back();
                });
            editor.attach();
        },
        choice: function (name: string, id: string, value: any, values?: any) {
            return arguments.length === 3
                ? { name: name, settingId: id, values: value }
                : { name: name, settingId: id, val: value, values: values };
        },
        label: label,
        rows: function (rows: any[]): any[] {
            rows.push(
                { cur: "", name: "", val: 0, values: w.noop || [] },
                {
                    cur: "",
                    name:
                        '<div class="btn">' + label("Save Settings") + "</div>",
                    val: 0,
                    values: saveCallback,
                }
            );
            return rows;
        },
        save: saveCallback,
    };
}

// ─── Settings UI functions (ported from original stbPlayer.js) ──────────────

/**
 * Show the "Interface settings" screen.
 * Offers options for: black screen on channel switch, PiP size/position,
 * font type, timezone, sleep timer, interface transparency, volume step,
 * color spectrum, background colors, permanent clock, graphical indication,
 * resume-after-pause behaviour, previous channels count, media history,
 * editor type, player type, and buffer size.
 *
 * Save commits the draft; cancelling discards it without persistence or effects.
 *
 * Side effects: Calls setTimezone(), setFontSize(), setListPos(),
 * setColor(), setEditor(), setPipPosBuf(), setPlayer(), setAutorun(),
 * stbSetBuffer(), showShift(), closeList(); writes to stb/provider storage.
 * Conditionally removes rows for unsupported features (no PiP, no volume,
 * etc.).
 */
window.settingsInterface = function (): void {
    var w = window as any;
    var showPlayerChoice =
        w.ott_device !== "lg/webos" &&
        !(w.ott_device === "pc2" && typeof w.videojs === "function");
    /**
     * Persist all interface settings and re-apply them.
     * Conditionally saves PiP, OSD opacity, volume step, and editor
     * settings based on capability. Calls all apply-functions after saving.
     */
    var page = createSettingsPage(
        w,
        "settingsInterface",
        "Interface settings",
        true,
        false
    );
    var choice = page.choice;
    var label = page.label;

    var mediaLanguageCodes = Object.keys(languageNames);
    var mediaLanguageLabels = mediaLanguageCodes.map(function (code) {
        return languageNames[code];
    });
    var noyes = [label("no"), label("yes")];
    var tz = (w.arrTimezone || ["system", "0"]).slice();
    tz[0] = w._(tz[0]) || tz[0];
    setListArrays(
        w,
        page.rows([
            choice(w._("Interface theme"), "interfaceTheme", [
                w._("Classic"),
                "PLi-HD",
                "Studio 2026",
            ]),
            {
                name: label("Preferred audio language"),
                settingId: "preferredAudioLanguage",
                settingValues: [""].concat(mediaLanguageCodes),
                values: [label("Player default")].concat(mediaLanguageLabels),
            },
            {
                name: label("Preferred subtitle language"),
                settingId: "preferredSubtitleLanguage",
                settingValues: ["", "off"].concat(mediaLanguageCodes),
                values: [label("Player default"), label("Off")].concat(
                    mediaLanguageLabels
                ),
            },
            choice(
                label("Black screen while switching the channel"),
                "stopPlay",
                noyes
            ),
            choice(label("PiP window size"), "pipSize", [
                label("small"),
                label("medium"),
                label("large"),
            ]),
            choice(label("PiP window position"), "pipPosition", [
                label("top-right"),
                label("bottom-right"),
                label("left-bottom"),
                label("top-left"),
            ]),
            choice(
                label("Font type"),
                "fontSize",
                w.__ottNativeFontOptions || [
                    '<span style="font-family:Helvetica, Arial, sans-serif;">' +
                        label("system") +
                        "</span>",
                    '<span style="font-family:Roboto;">Roboto</span>',
                    '<span style="font-family:RobotoCondensed;">Roboto Condensed</span>',
                    '<span style="font-family:Caveat;">Caveat</span>',
                    '<span style="font-family:Liberation;">Liberation</span>',
                    '<span style="font-family:Gabriela;">Gabriela</span>',
                    '<span style="font-family:PTSansNarrow;">PTSansNarrow</span>',
                ]
            ),
            choice(label("Timezone"), "timezone", tz),
            choice(label("Sleep timer"), "sleepTimeout", [
                label("off"),
                label("30 minutes"),
                label("1 hour"),
                label("2 hours"),
                label("3 hours"),
            ]),
            choice(label("Interface transparency"), "osdOpacity", [
                "100%",
                "90%",
                "80%",
                "70%",
                "60%",
                "50%",
                "40%",
                "30%",
                "20%",
                "10%",
                "0%",
            ]),
            {
                name: label("Volume step, %"),
                settingId: "volumeStep",
                settingOffset: 3,
                values: [3, 4, 5, 6, 7, 8, 9, 10],
            },
            {
                cur: label("select"),
                name: w._("Color spectrum") + " (" + w._("Classic") + ")",
                settingId: "highlightColor",
                values: w.colorDialog,
            },
            {
                cur: label("select"),
                name:
                    w._("Background color of selected item") +
                    " (" +
                    w._("Classic") +
                    ")",
                settingId: "highlightColorSel",
                values: w.selColorDialog,
            },
            {
                cur: label("select"),
                name: w._("Background color") + " (" + w._("Classic") + ")",
                settingId: "highlightColorB",
                values: w.backColorDialog,
            },
            choice(label("Permanent clock on screen"), "permanentTime", [
                label("no"),
                label("yes"),
                label("transparent"),
            ]),
            choice(
                label("Graphical indication"),
                "useGraphicalIndicators",
                noyes
            ),
            choice(
                label("Position shift -10 seconds after pause"),
                "resumeWithTenSecondRewind",
                noyes
            ),
            choice(
                label("Remember previous channels"),
                "prevCount",
                [1, 5, 10, 15, 20]
            ),
            choice(label("History in Media Library"), "medCount", [
                label("no"),
                10,
                20,
                30,
                40,
                50,
            ]),
            choice(label("Editor"), "editor", [
                label("built-in"),
                label("native"),
            ]),
            choice(
                label("Type of player for streaming"),
                "players",
                w.playerModeNames
            ),
            {
                name: label("Maximum video height") + " (HLS/Shaka)",
                settingId: "streamMaxHeight",
                settingValues: [0, 360, 480, 720, 1080, 2160],
                values: [
                    label("Automatic"),
                    "360p",
                    "480p",
                    "720p",
                    "1080p",
                    "2160p",
                ],
            },
            {
                name: label("Maximum stream bitrate") + " (HLS/Shaka)",
                settingId: "streamMaxBitrate",
                settingValues: [
                    0, 1000000, 2000000, 4000000, 8000000, 16000000,
                ],
                values: [
                    label("Automatic"),
                    "1 Mbps",
                    "2 Mbps",
                    "4 Mbps",
                    "8 Mbps",
                    "16 Mbps",
                ],
            },
            choice(label("Buffer Size, s"), "bufSize", w.bufferSizes),
        ])
    );
    setListArrays(
        w,
        w.listArray.filter(function (row: any): boolean {
            if (
                row.settingId === "preferredAudioLanguage" ||
                row.settingId === "preferredSubtitleLanguage"
            )
                return (
                    !!w.__ottCoreTransport &&
                    w.stbPlay === w.__ottCoreTransport.play
                );
            if (row.settingId === "players") {
                if (Array.isArray(w.stbPlayers)) row.values = w.stbPlayers;
                return showPlayerChoice;
            }
            if (row.settingId === "bufSize") {
                if (w.stbBufferSizes) row.values = w.stbBufferSizes;
                return typeof w.stbSetBuffer === "function";
            }
            if (row.settingId === "editor")
                return typeof w.showEditKey2 === "function";
            if (row.settingId === "medCount")
                return (
                    typeof w.getMediaArray === "function" ||
                    !!(w.__ottNasLibrary && w.__ottNasLibrary.available())
                );
            if (row.settingId === "volumeStep")
                return typeof w.stbGetVolume === "function";
            if (row.settingId === "osdOpacity")
                return typeof w.stbSetOsdOpacity === "function";
            if (row.settingId === "pipSize" || row.settingId === "pipPosition")
                return typeof w.stbPlayPip === "function";
            return true;
        })
    );
    page.attach();
};

/**
 * Show the "Infobar settings" screen.
 * Options: infobar display timeout, sliding infobar, show on switch,
 * show on program change, show on rewind, show thumbnails.
 *
 * Inner function save() persists each value.
 *
 * Side effects: Calls showShift(), closeList(); writes to stb storage.
 */
window.settingsInfobar = function (): void {
    var w = window as any;

    /** Persist infobar settings (timeout, slide, switch, change, rewind, thumbnails). */
    var page = createSettingsPage(
        w,
        "settingsInfobar",
        "Infobar settings",
        true,
        false
    );
    var choice = page.choice;
    var label = page.label;

    var noyes = [label("no"), label("yes")];
    setListArrays(
        w,
        page.rows([
            {
                name: label("Infobar display timeout, s"),
                settingId: "infoTimeout",
                settingOffset: 3,
                val: w.sInfoTimeout - 3,
                values: [3, 4, 5, 6, 7, 8, 9, 10],
            },
            choice(
                label('"Sliding" infobar'),
                "infoSlide",
                w.sInfoSlide,
                noyes
            ),
            choice(
                label("Show when switching"),
                "infoSwitch",
                w.sInfoSwitch,
                noyes
            ),
            choice(
                label("Show when changing program"),
                "infoChange",
                w.sInfoChange,
                noyes
            ),
            choice(label("Show when rewind"), "infoRew", w.sInfoRew, noyes),
            choice(label("Show thumbnails"), "thumbnail", w.sThumbnail, noyes),
        ])
    );
    page.attach();
};

/**
 * Show the "Lists settings" screen.
 * Options: reduce video when list is shown, number of rows, line spacing,
 * list position (left/right), show scrollbar.
 *
 * Inner function save() persists each value and re-applies fonts and
 * positions.
 *
 * Side effects: Calls setFontSize(), setListPos(), setColor(),
 * showShift(), closeList(); writes to stb storage.
 */
window.settingsLists = function (): void {
    var w = window as any;

    /** Persist list settings (noSmall, pageSize, fontShift, listPos, showScroll) and re-apply. */
    var page = createSettingsPage(
        w,
        "settingsLists",
        "Lists settings",
        true,
        false
    );
    var choice = page.choice;
    var label = page.label;

    var noyes = [label("no"), label("yes")];
    setListArrays(
        w,
        page.rows([
            choice(
                label("Not reduce video when showing the list (bugfix)"),
                "noSmall",
                w.sNoSmall,
                noyes
            ),
            {
                name: label("Number of rows in lists"),
                settingId: "pageSize",
                settingOffset: 10,
                val: w.sPageSize - 10,
                values: [
                    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
                    25, 26, 27, 28, 29, 30,
                ],
            },
            choice(
                label("Distance between lines in lists"),
                "fontShift",
                w.sFontShift,
                [
                    "0",
                    1,
                    2,
                    3,
                    4,
                    5,
                    6,
                    7,
                    8,
                    9,
                    10,
                    11,
                    12,
                    13,
                    14,
                    15,
                    16,
                    17,
                    18,
                    19,
                    20,
                    21,
                    22,
                    23,
                    24,
                    25,
                    26,
                    27,
                    28,
                    29,
                    30,
                ]
            ),
            choice(label("List location"), "listPosition", w.sListPos, [
                label("right"),
                label("left"),
            ]),
            choice(
                label("Show scrollbar in list"),
                "showScroll",
                w.sShowScroll,
                noyes
            ),
        ])
    );
    page.attach();
};

/**
 * Show the "Channel list settings" screen.
 * Options: show number, picons, channel name, program name, progress bar,
 * archive indicator, description, preview mode, next programs count,
 * editing style (categories vs. favorites).
 *
 * Inner function save() persists each value.
 *
 * Side effects: Calls showShift(), closeList(); writes to provider/storage.
 */
window.settingsChannels = function (): void {
    var w = window as any;

    /** Persist channel list display settings (showNum, showPikon, showName, etc.). */
    var page = createSettingsPage(
        w,
        "settingsChannels",
        "Channel list settings",
        true,
        false
    );
    var choice = page.choice;
    var label = page.label;

    var noyes = [label("no"), label("yes")];
    setListArrays(
        w,
        page.rows([
            choice(
                label("Show channel number in list"),
                "showNumber",
                w.sShowNum,
                noyes
            ),
            choice(
                label("Show picons in channel list"),
                "channelLogoMode",
                w.sShowPikon,
                [label("no"), "1x1", "3x4"]
            ),
            choice(
                label("Show channel name in list"),
                "showName",
                w.sShowName,
                noyes
            ),
            choice(
                label("Show program name"),
                "showProgram",
                w.sShowProgram,
                noyes
            ),
            choice(
                label("Show progress in channel list"),
                "showProgress",
                w.sShowProgress,
                noyes
            ),
            choice(
                label("Show archive availability in list"),
                "showArchive",
                w.sShowArchive,
                noyes
            ),
            choice(
                label("Show description"),
                "showDescription",
                w.sShowDescr,
                noyes
            ),
            choice(label("Preview in channel list"), "preview", w.sPreview, [
                label("no"),
                label("always"),
                (w._("on ") || "on ") + (w.strENTER || "ENTER"),
            ]),
            choice(
                label("Number of next TV programs in channel list"),
                "nextCountList",
                w.sNextCountL,
                [label("no"), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
            ),
            choice(
                label("Channel list editing style"),
                "favorites",
                w.sFavorites !== -1 ? w.sFavorites : w.noop || [],
                w.sFavorites !== -1
                    ? [label("All categories"), label('"Favorites"')]
                    : '<span style="color:gray;">' +
                          label('"Favorites"') +
                          "</span>"
            ),
        ])
    );
    page.attach();
};

/**
 * Show the "Buttons settings" screen.
 * Configures behaviour of arrow keys, RW/FF, PREV/NEXT, colour buttons,
 * RETURN, ENTER, and number-row seek step durations.
 * Dynamically removes rows for hardware keys that don't exist.
 *
 * Inner function save() persists each value.
 *
 * Side effects: Calls showShift(), closeList(); writes to stb storage.
 */
window.settingsButtons = function (): void {
    var w = window as any;

    /** Persist button mapping settings (arrow fun, rewind fun, colour buttons, seek steps). */
    var page = createSettingsPage(
        w,
        "settingsButtons",
        "Buttons settings",
        true,
        false
    );
    var choice = page.choice;
    var label = page.label;

    var r = "Behavior of %1/%2 buttons in lists";
    var s = "Button %1 function when viewing";
    var n = "Rewind step by buttons %1/%2";
    var ia = '<div class="btn';
    var a = ia + '">';
    var o = "</div>";
    var l = '">&nbsp;' + o;
    var c = [label("paging"), label("volume"), "dune-php", "neutrino"];
    var u = [
        label("Records"),
        label("Menu"),
        label("Previous"),
        label("Rewind"),
        label("Info"),
        label("Aspect"),
        label("Audio"),
        "PiP",
        label("Close PiP"),
        label("Category"),
        label("EPG"),
        label("Media"),
        label("Joystick"),
        "V+",
        "V-",
        "P+",
        "P-",
        label("Subtitle"),
        "-1 " + label(" m ").trim(),
        "+1 " + label(" m ").trim(),
        label("Prev"),
        label("Next"),
    ];
    var d = [
        5, 10, 15, 20, 30, 60, 120, 180, 240, 300, 600, 900, 1200, 1800, 3600,
    ];
    var p = d.map(function (e: number) {
        return typeof w.formatSeekOffset === "function"
            ? w.formatSeekOffset(e).substr(2).trim()
            : e.toString();
    });
    if (typeof w.stbToggleAspectRatio !== "function") u[5] = "@@@";
    if (typeof w.stbToggleAudioTrack !== "function") u[6] = "@@@";
    if (typeof w.stbPlayPip !== "function") {
        u[7] = "@@@";
        u[8] = "@@@";
    }
    if (typeof w.stbGetVolume !== "function") {
        u[13] = "@@@";
        u[14] = "@@@";
        c[1] = "@@@";
    }
    if (typeof w.stbToggleSubtitle !== "function") u[17] = "@@@";
    var noyes = [label("no"), label("yes")];
    w.listArray = page.rows([
        choice(
            w._(r, a + (w.strLEFT || "L") + o, a + (w.strRIGHT || "R") + o),
            "arrowFun",
            w.sArrowFun,
            c
        ),
        choice(
            w._(r, a + (w.strRW || "RW") + o, a + (w.strFF || "FF") + o),
            "rewFun",
            w.sRewFun,
            [label("paging"), "dune-php", "neutrino"]
        ),
        choice(
            w._(
                r,
                a + (w.strPREV || "PREV") + o,
                a + (w.strNEXT || "NEXT") + o
            ),
            "pnFun",
            w.sPNFun,
            [label("paging"), "dune-php", "neutrino", label("begin/end")]
        ),
        choice(w._(s, a + (w.strLEFT || "L") + o), "alFun", w.sALfun, u),
        choice(w._(s, a + (w.strRIGHT || "R") + o), "arFun", w.sARfun, u),
        choice(w._(s, a + (w.strUP || "U") + o), "auFun", w.sAUfun, u),
        choice(w._(s, a + (w.strDOWN || "D") + o), "adFun", w.sADfun, u),
        choice(w._(s, a + (w.strRW || "RW") + o), "rwFun", w.sRWfun, u),
        choice(w._(s, a + (w.strFF || "FF") + o), "ffFun", w.sFFfun, u),
        choice(w._(s, a + (w.strPREV || "PREV") + o), "prevFun", w.sPREVfun, u),
        choice(w._(s, a + (w.strNEXT || "NEXT") + o), "nextFun", w.sNEXTfun, u),
        choice(w._(s, ia + " red" + l), "rFun", w.sRfun, u),
        choice(w._(s, ia + " green" + l), "gFun", w.sGfun, u),
        choice(w._(s, ia + " yellow" + l), "yFun", w.sYfun, u),
        choice(w._(s, ia + " blue" + l), "bFun", w.sBfun, u),
        choice(w._(s, a + (w.strRETURN || "RET") + o), "eFun", w.sEfun, [
            label("Nothing"),
            label("Exit"),
            label("Joystick"),
            label("Menu"),
            label("Previous"),
        ]),
        choice(
            w._(
                "Button function %1 when viewing archive",
                a + (w.strENTER || "ENTER") + o
            ),
            "okFun",
            w.sOkfun,
            [label("EPG"), label("Channels")]
        ),
        {
            name: w._(n, a + 1 + o, a + 3 + o),
            settingId: "seek13Duration",
            settingValues: d,
            val: d.indexOf(normalizeSeekDuration(w.s13dur, 15)),
            values: p,
        },
        {
            name: w._(n, a + 4 + o, a + 6 + o),
            settingId: "seek46Duration",
            settingValues: d,
            val: d.indexOf(normalizeSeekDuration(w.s46dur, 180)),
            values: p,
        },
        {
            name: w._(n, a + 7 + o, a + 9 + o),
            settingId: "seek79Duration",
            settingValues: d,
            val: d.indexOf(normalizeSeekDuration(w.s79dur, 600)),
            values: p,
        },
        choice(
            label("Remote (color buttons N/A)"),
            "noColorKeys",
            w.sNoColorKeys,
            noyes
        ),
        choice(
            label("Remote (number buttons N/A)"),
            "noNumbersKeys",
            w.sNoNumbersKeys,
            noyes
        ),
    ]);
    setListArrays(
        w,
        w.listArray.filter(function (row: any): boolean {
            var id = row.settingId;
            if (
                w.sNoNumbersKeys &&
                ["seek13Duration", "seek46Duration", "seek79Duration"].indexOf(
                    id
                ) !== -1
            )
                return false;
            if (
                w.sNoColorKeys &&
                ["rFun", "gFun", "yFun", "bFun"].indexOf(id) !== -1
            )
                return false;
            if (
                !w.keys.PREV &&
                ["prevFun", "nextFun", "pnFun"].indexOf(id) !== -1
            )
                return false;
            if (!w.keys.RW && ["rwFun", "ffFun", "rewFun"].indexOf(id) !== -1)
                return false;
            return true;
        })
    );
    page.attach();
};

/**
 * Show the "Menu items settings" screen.
 * Allows the user to show/hide individual popup menu items by toggling
 * a yes/no value per entry.
 *
 * Inner function save() builds sHideMenus array and persists it.
 *
 * Side effects: Writes 'sHideMenus' to stb storage; calls showShift().
 */
window.settingsMenu = function (): void {
    var w = window as any;

    /** Build the sHideMenus array from toggled list items and persist it. */
    var page = createSettingsPage(
        w,
        "settingsMenu",
        "Select menu items",
        false,
        false
    );
    var label = page.label;

    var noyes = [label("yes"), label("no")];
    w.listArray = [];
    for (
        var i = 0;
        i < w.popupActions.indexOf(w.toggleProviderSettingsVisibility);
        i++
    ) {
        w.listArray.push({
            name: w._(w.popupArray[i]),
            optionId: popupActionId(w.popupActions[i]),
            settingId: "hideMenus",
            val:
                (w.sHideMenus || []).indexOf(
                    popupActionId(w.popupActions[i])
                ) === -1
                    ? 0
                    : 1,
            values: noyes,
        });
    }
    w.listArray.push({ cur: "", name: "", val: 0, values: w.noop || [] });
    w.listArray.push({
        cur: "",
        name: '<div class="btn">' + label("Save Settings") + "</div>",
        val: 0,
        values: page.save,
    });
    page.attach();
};

// Legacy device/provider API; implementation belongs to the settings module.
window.exportSettingsUI = exportSettingsUI;
window.importSettingsUI = importSettingsUI;

/**
 * Show the "Manage settings" screen.
 * Options: save settings (cloud), load settings (cloud), clear settings,
 * enter provider code, enter provider code (remote).
 * Dynamically adds/removes entries based on available capabilities
 * (stbClearAllItems, stbGetAllItems, loadOpt, saveOpt).
 *
 * Inner function clearSettings() confirms then clears all items and
 * restarts.
 *
 * Side effects: Calls restart() on clear; writes to storage.
 */
window.settingsManage = function (): void {
    var w = window as any;
    function label(key: string): string {
        return w._(key) || key;
    }
    /**
     * Prompt the user to confirm, then clear all stb storage items and
     * restart the player.
     *
     * Side effects: Calls stbClearAllItems() then restart().
     */
    function clearSettings(): void {
        if (typeof w.confirmBox === "function") {
            w.confirmBox("Clear all settings?", function () {
                try {
                    if (
                        w.__ottClassicPlayback &&
                        typeof w.__ottClassicPlayback.suspendPersistence ===
                            "function"
                    )
                        w.__ottClassicPlayback.suspendPersistence();
                    if (w.__ottClassicGuide)
                        w.__ottClassicGuide.invalidate(false);
                    if (typeof w.stbClearAllItems === "function")
                        w.stbClearAllItems();
                } catch (e) {
                    console.error(e);
                }
                if (typeof w.restart === "function") w.restart();
            });
        }
    }
    var gap = { action: w.noop || function () {}, name: "" };
    w.listArray = [
        {
            action: w.cloudSendSettings,
            name: label("Save settings"),
        },
        {
            action: w.cloudLoadSettings,
            name: label("Load settings"),
        },
        gap,
        {
            action: w.exportSettingsUI,
            name: label("Export settings"),
        },
        {
            action: w.importSettingsUI,
            name: label("Import settings"),
        },
        gap,
        {
            action: clearSettings,
            name: label("Clear settings"),
        },
        gap,
        {
            action: w.edit_dealer,
            name: label("Enter Provider Code"),
        },
        {
            action: w.edit_dealer_remote,
            name: label("Enter Provider Code on PC or Phone"),
        },
        {
            action: function () {
                if (
                    typeof (window as any).__ottDebug !== "undefined" &&
                    typeof (window as any).__ottDebug.toggleHud === "function"
                ) {
                    (window as any).__ottDebug.toggleHud();
                } else {
                    try {
                        if (typeof localStorage !== "undefined") {
                            localStorage.setItem("ottplay_debug", "1");
                            localStorage.setItem("ottplay_debug_hud", "1");
                        }
                    } catch (_e) {}
                    if (typeof (window as any).infoBox === "function") {
                        (window as any).infoBox(
                            _("Debug enabled. Restart to apply.")
                        );
                    }
                }
            },
            name: label("Debug HUD"),
        },
    ];
    if (typeof w.stbClearAllItems !== "function") w.listArray.splice(6, 1);
    if (typeof w.stbGetAllItems !== "function") w.listArray.splice(0, 1);
    if (isPlayDistribution()) {
        w.listArray = w.listArray.filter(function (item: any): boolean {
            return (
                item.action !== w.edit_dealer &&
                item.action !== w.edit_dealer_remote &&
                item.action !== w.cloudLoadSettings &&
                item.action !== w.importSettingsUI
            );
        });
    }
    if (!isPlayDistribution() && typeof w.loadOpt === "function")
        w.listArray.splice(0, 0, {
            action: w.loadOpt,
            name: label("Load settings from storage"),
        });
    if (typeof w.saveOpt === "function")
        w.listArray.splice(0, 0, {
            action: w.saveOpt,
            name: label("Save settings to storage"),
        });
    var sourceAccess = accessMediaPlugin();
    if (sourceAccess)
        w.listArray.push({
            action: function () {
                sourceAccess.manage({
                    labels: {
                        busy: _("Another source sign-in is already open"),
                        cancelled: _("Source sign-in was cancelled"),
                        close: _("Close"),
                        empty: _(
                            "Sign-in opens when you load a protected playlist."
                        ),
                        invalid: _("Invalid protected source configuration"),
                        login: _("Sign in to the protected source again"),
                        ok: _("Ok"),
                        signIn: _("Sign in: %1"),
                        signOut: _("Sign out of all sources"),
                        title: _("Source access"),
                        unavailable: _("Protected source is unavailable"),
                    },
                });
            },
            name: w._("Source access"),
        });
    w.selIndex = 0;
    w.getListItem = function (item: any, _idx: number) {
        return "&nbsp;&nbsp;" + (item.name || "");
    };
    w.detailListActionFn = function () {};
    w.detailListAction = function () {
        var detailEl = document.getElementById("listDetail");
        if (detailEl)
            detailEl.innerHTML = w._(
                w.listArray[w.selIndex].desc ||
                    w.listArray[w.selIndex].name ||
                    ""
            );
    };
    w.listKeyHandlerFn = function (key: number): boolean {
        switch (key) {
            case w.keys.RETURN:
                w.optionsList(w.settingsManage);
                return true;
            case w.keys.ENTER:
                if (w.listArray[w.selIndex].action)
                    w.listArray[w.selIndex].action();
                return true;
        }
        return false;
    };
    var capEl = document.getElementById("listCaption");
    if (capEl) capEl.innerHTML = label("Manage settings");
    var footerElement = document.getElementById("listPodval");
    if (footerElement)
        footerElement.innerHTML = w.renderButtonHint(
            w.keys.RETURN,
            w.strRETURN,
            "Close"
        );
    if (typeof jQuery !== "undefined") jQuery("#listPopUp").hide();
    w.listDataArray = w.listArray;
    if (typeof w.showPage === "function") w.showPage();
    var owner =
        w.__ottClassicScreenPort && w.__ottClassicScreenPort.listOwner();
    if (owner) owner.model.localOnlyInput = true;
};

// Cloud-based send/load settings (from original stbPlayer.js)

window.cloudSendSettings = cloudSendSettings;

window.cloudLoadSettings = cloudLoadSettings;

// Window aliases for imported functions needed by settings functions
window.edit_dealer = edit_dealer;
window.edit_dealer_remote = edit_dealer_remote;

// @legacy-bridge: provider settings entry — edit_dealer reads/writes window.editvar for
// the provider code field. Required by: stalker provider (portal URL entry).
window._enterPinCode = _enterPinCode;
window.enterPinCode = enterPinCode;
window.enterPinAndSetAccess = enterPinAndSetAccess;
window.setParentAccess = setParentAccess;
window.parentControlSetup = parentControlSetup;

/* ---------------------------------------------------------------------------
 * Channel list popup helpers
 * --------------------------------------------------------------------------- */

/**
 * Preview a channel in the video area (used when sPreview=1 in channel
 * lists). Stops current playback and starts the new channel URL after
 * a 500ms debounce delay.
 *
 * @param chId - The channel ID string to preview.
 *
 * Side effects: Calls stbStop(), then stbPlay(getChannelUrl(chId)) after
 * a timeout. Updates previewChan. Clears previous previewTimer.
 */
window.previewChId = function (chId: number): void {
    var w = window as any;
    if (w.previewChan && w.previewChan.ch_id === chId) return;
    clearTimeout(w.previewTimer);
    if (
        typeof w.ifParentalAccessChId === "function" &&
        w.ifParentalAccessChId(
            chId,
            w.__ottParental.guard(chId, function () {
                w.previewChId(chId);
            })
        )
    )
        return;
    w.previewTimer = setTimeout(
        w.__ottParental.guard(chId, function () {
            if (w.sStopPlay && typeof w.stbStop === "function") w.stbStop();
            w.previewChan = { c: 0, ch_id: chId, i: 0 };
            if (typeof w.stbPlay === "function")
                w.stbPlay(
                    typeof w.getChannelUrl === "function"
                        ? w.getChannelUrl(chId)
                        : null
                );
        }),
        500
    );
};

/**
 * Add the currently selected channel to either the Favorites list or to
 * another category. In "Favorites" mode, directly pushes the channel.
 * In category mode, shows a sub-list of categories to choose from.
 *
 * Side effects: Mutates cats[favorites] or cats[selectedCategory];
 * calls saveChannelsCats(), showShift(); DOM mutations to listCaption,
 * listFooter; saves/restores CPD.
 *
 * Edge case: Returns early if sFavorites and !listCatIndex.
 */
window.addChannel2bucket = function (): void {
    var w = window as any;
    // Owned search supplies an explicit return; historical callers keep zero arity.
    var resume = typeof arguments[0] === "function" ? arguments[0] : null;
    var idx = w.selIndex;
    var chId = w.listArray[idx];
    if (w.sFavorites) {
        if (!w.listCatIndex) return;
        addToFavorites(chId);
        if (typeof w.saveChannelsCats === "function") w.saveChannelsCats();
        if (typeof w.showShift === "function")
            w.showShift(
                (w._("Channel ") || "Channel ") +
                    (w.channels && w.channels[chId]
                        ? w.channels[chId].channel_name
                        : "") +
                    (w._(" added to favorites") || " added to favorites")
            );
    } else {
        var context = resume && w.__ottChannels.capture(w.listCatIndex);
        if (resume && !context) return;
        var picker: any = resume && w.__ottClassicScreenPort.listOwner();
        var handler: any = null;
        var groupIds =
            resume &&
            w.catsArray.slice(1).map(function (_label: string, index: number) {
                return w.__ottChannels.group(index + 1);
            });
        var admitted = function (): boolean {
            return (
                !resume ||
                !!(
                    context.active() &&
                    picker &&
                    picker.foreground() &&
                    (!handler || w.listKeyHandlerFn === handler)
                )
            );
        };
        if (typeof w.saveListPanelState === "function") w.saveListPanelState();
        if (!admitted()) return;
        var savedIdx = w.selIndex;
        var savedList = w.listArray;
        var savedGetListItem = w.getListItem;
        var savedDetailListAction = w.detailListAction;
        var savedListKeyHandler = w.listKeyHandlerFn;
        var popupVisible =
            typeof $ !== "undefined" && $("#listPopUp").is(":visible");
        if (!admitted()) return;
        w.selIndex = 0;
        w.listArray = w.catsArray.slice(1);
        if (resume) w.listDataArray = w.listArray;
        w.getListItem = function (item: any, _idx: number): string {
            return "&nbsp;&nbsp;" + item;
        };
        w.detailListAction = function (): void {};
        w.listKeyHandlerFn = handler = function (e: number): boolean {
            if (!admitted()) return true;
            switch (e) {
                case w.keys.ENTER:
                    var groupId = resume
                        ? groupIds[w.selIndex]
                        : w.__ottChannels.group(
                              w.catsArray.indexOf(w.listArray[w.selIndex])
                          );
                    if (
                        resume &&
                        (!context.position(chId) ||
                            w.__ottChannels.index(groupId) < 0)
                    )
                        return true;
                    w.__ottChannels.change("member", {
                        action: "add",
                        channelId: chId,
                        groupId: groupId,
                    });
                    if (!admitted()) return true;
                    if (typeof w.saveChannelsCats === "function")
                        w.saveChannelsCats();
                    if (!admitted()) return true;
                    if (typeof w.showShift === "function") {
                        var message =
                            (w._("Channel ") || "Channel ") +
                            (w.channels && w.channels[chId]
                                ? w.channels[chId].channel_name
                                : "") +
                            (w._(" added to category ") ||
                                " added to category ") +
                            w.listArray[w.selIndex];
                        if (!admitted()) return true;
                        w.showShift(message);
                    }
                    break;
                case w.keys.RETURN:
                    break;
                default:
                    return false;
            }
            if (!admitted()) return true;
            if (resume) {
                w.getListItem = savedGetListItem;
                w.detailListAction = savedDetailListAction;
                resume(admitted);
                return true;
            }
            if (typeof w.restoreListPanelState === "function")
                w.restoreListPanelState();
            w.selIndex = savedIdx;
            w.listArray = savedList;
            w.getListItem = savedGetListItem;
            w.detailListAction = savedDetailListAction;
            w.listKeyHandlerFn = savedListKeyHandler;
            if (typeof w.showPage === "function") w.showPage();
            if (popupVisible && typeof $ !== "undefined")
                $("#listPopUp").show();
            return true;
        };
        var caption =
            w._("Select category to add channel") ||
            "Select category to add channel";
        if (!admitted()) return;
        var captionEl = document.getElementById("listCaption");
        if (captionEl) captionEl.innerHTML = caption;
        var footerElement = document.getElementById("listPodval");
        if (footerElement) {
            var footer = w.renderButtonHint(
                w.keys.RETURN,
                w.strRETURN,
                "Close"
            );
            if (!admitted()) return;
            footerElement.innerHTML = footer;
        }
        if (typeof $ !== "undefined") $("#listPopUp").hide();
        if (!admitted()) return;
        if (typeof w.showPage === "function") w.showPage();
        if (resume) picker = w.__ottClassicScreenPort.listOwner();
    }
};

/**
 * Toggle parental control on the currently selected channel.
 * Adds/removes the channel ID from parentalArray.
 * Requires parental PIN access.
 *
 * Side effects: Mutates parentalArray; calls providerSetItem() to persist;
 * calls showPage() to re-render the list.
 */
window.parentChannel = function (): void {
    var w = window as any;
    if (!w.sPSchannels || w.parentPIN === "*") return;
    var chId = w.listArray[w.selIndex];
    var apply = w.__ottParental.guard(chId, function () {
        var pos = w.parentalArray.indexOf(chId);
        w.__ottChannels.change("lock", chId, pos === -1);
        if (typeof w.showPage === "function") w.showPage();
    });
    if (!w.__ottParental.require("channels", apply)) apply();
};
window.stbToggleZoom = stbToggleZoom;
window.stbCSS = stbCSS;
window.stbInit = stbInit;
window.stbExit = stbExit;

// Tauri Mode B: real app exit (window.close() does not quit Tauri).
if (typeof window.__TAURI__ !== "undefined") {
    window.stbExit = function (): void {
        if (window.__ottRemoteInputActive) return;
        try {
            body_onUnload();
        } catch (_) {
            // Optional persistence must not prevent an explicit app exit.
        }
        tauriInvoke<any>("exit_app", {}).catch((e: any) =>
            console.warn("[Tauri] exit_app failed:", e)
        );
    };
}

// Stop both the decoder and native media session before finishing the Activity.
if (typeof (window as any).Capacitor !== "undefined") {
    window.stbExit = function (): void {
        if (window.__ottRemoteInputActive) return;
        try {
            body_onUnload();
        } catch (_) {
            // An explicit exit must still finish if persistence is unavailable.
        }
        if (typeof window.stbStop === "function") window.stbStop();
        const Cap = (window as any).Capacitor;
        const plugins = Cap && Cap.Plugins ? Cap.Plugins : null;
        void (async function () {
            const media = plugins && plugins.MobileNativeMedia;
            try {
                if (media && typeof media.stopBackgroundAudio === "function")
                    await media.stopBackgroundAudio();
            } catch (e) {
                console.warn("[Capacitor] media stop failed:", e);
            }
            try {
                const App = plugins && plugins.App;
                if (App && typeof App.exitApp === "function") {
                    await App.exitApp();
                    return;
                }
            } catch (e) {
                console.warn("[Capacitor] App.exitApp failed:", e);
            }
            try {
                if (media && typeof media.exitApp === "function") {
                    await media.exitApp();
                    return;
                }
            } catch (e) {
                console.warn(
                    "[Capacitor] MobileNativeMedia.exitApp failed:",
                    e
                );
            }
            try {
                window.close();
            } catch (_e) {}
        })();
    };
}
installRemoteLifecycle(window, {
    mobileMedia: MobileNativeMedia,
    prepare: function (): void {
        try {
            body_onUnload();
        } finally {
            if (typeof window.stbStop === "function") window.stbStop();
        }
    },
});
window.setPlayer = setPlayer;
window.stbGetItem = stbGetItem;
installStandby(window, stbGetItem, stbSetItem);
if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    window.__ottNativeStandby = function (standby: boolean) {
        return tauriInvoke("set_background_standby", { standby: standby });
    };
    window.__ottStandby.native(window.__ottNativeStandby, function () {
        return tauriInvoke("background_standby_status", {});
    });
} else if (window.Capacitor && window.Capacitor.isNativePlatform?.()) {
    var nativeBackground = resolveNativePlugin<any>(
        "NativeBackground",
        function () {
            return {};
        }
    );
    window.__ottNativeStandby = function (standby: boolean) {
        if (!nativeBackground.setStandby)
            return Promise.reject(new Error("Native standby unavailable"));
        return nativeBackground.setStandby({ standby: standby });
    };
    window.__ottStandby.native(window.__ottNativeStandby, function () {
        return nativeBackground.status();
    });
}
(window as any).stbGetPersistedItem = stbGetPersistedItem;
window.stbSetItem = stbSetItem;
window.stbDelItem = stbDelItem;
window.stbClearAllItems = stbClearAllItems;
window.stbGetAllItems = stbGetAllItems;
window.providerGetItem = providerGetItem;
window.providerSetItem = providerSetItem;
window.providerHasItem = providerHasItem;
window.providerHasItemValue = providerHasItemValue;
window.providerDelItem = providerDelItem;
window._ = translate;
window.saveAllOptions = saveAllOptions;
window.loadAllOptions = loadAllOptions;
window.saveOpt = saveAllOptions;
window.loadOpt = loadAllOptions;
window.body_onUnload = body_onUnload;
window.playArchive = playArchive;
window.fileArchive = fileArchive;
window.shiftArchive = shiftArchive;
window.showPlaybackSeekDialog = showPlaybackSeekDialog;
window.replayFromLiveOffset = replayFromLiveOffset;
window.checkMedia = checkMedia;
window.setCurrent = setCurrent;
window.publishChannelProgrammeRows = publishChannelProgrammeRows;
window.observeCurrentProgramme = observeCurrentProgramme;

(window as any).fetchChannelGuide = fetchChannelGuide;
window.getChannelEpgCached = getChannelEpgCached;
window.nextChannel = nextChannel;
window.prevChannel = prevChannel;
window.handleNumberInput = handleNumberInput;
window.getChannelUrl = getChannelUrl;
window.addToFavorites = addToFavorites;
window.removeFromFavorites = removeFromFavorites;
window.saveChannelsCats = saveChannelsCats;
window.popFavLists = popFavLists;
window.getActiveFavoritesListName = getActiveFavoritesListName;
window.setActiveFavoritesList = setActiveFavoritesList;
window.addFavoritesList = addFavoritesList;
window.renameFavoritesList = renameFavoritesList;
window.deleteFavoritesList = deleteFavoritesList;
window.listFavoritesLists = listFavoritesLists;
window.epgList = epgList;
window.epgListAlpha = epgListAlpha;
window.loadEpgListData = loadEpgListData;
(window as any).renderGuideView = renderGuideView;
(window as any).renderCategoryRecordings = renderCategoryRecordings;
(window as any).publishGuideReminders = publishGuideReminders;
window.epgKeyHandler = epgKeyHandler;
window.renderEpgFooter = renderEpgFooter;
window.detailEPG = detailEPG;
window.setEpgTimer = setEpgTimer;
window.itemEPG = itemEPG;
window.epgArray = epgArray;
window.listEpgArray = listEpgArray;
window.epg_ch_id = epg_ch_id;
window.epgListMode = epgListMode;
window.epgreturn = epgreturn;
window.channelsList = channelsList;
window.bucketsList = bucketsList;
window.recordsList = recordsList;
window.selectEpg = selectEpg;
window.showProgramInfo = showProgramInfo;
window.updateArchiveInfo = updateArchiveInfo;
window.initBackgroundIntervals = initBackgroundIntervals;
window.renderButtonHint = renderButtonHint;
window.setPipPosition = setPipPosition;
window.getPipPosition = setPipPosition;

// Native PiP is a decoder port; the backend retains the only play/stop entrypoints.
if (typeof window.__TAURI__ !== "undefined") {
    (function () {
        function bounds(): void {
            var w = window as any;
            tauriInvoke<any>("set_pip_bounds", {
                position: Number(w.sPipPos) || 0,
                size: Number(w.sPipSize) || 0,
            }).catch(function (error: any) {
                console.warn("[Tauri] PiP bounds failed:", error);
            });
        }
        (window as any).__ottCoreTransport.configure({
            pip: (window as any).__ottNativePip.create({
                error: function (error: any) {
                    console.warn("[Tauri] PiP failed:", error);
                },
                invoke: function (action: string, args: any) {
                    return tauriInvoke<any>(
                        action === "play" ? "play_pip" : "stop_pip",
                        args
                    );
                },
                ready: function () {
                    var el = document.getElementById("videopip");
                    if (el) el.style.display = "none";
                    bounds();
                },
                request: function (url: string, id: number) {
                    var absoluteUrl = url;
                    try {
                        absoluteUrl = new URL(url, window.location.href).href;
                    } catch (_) {}
                    var demo = (window as any).ottplayDemoActive === true;
                    return {
                        engine:
                            demo && /\.mp4(?:[?#]|$)/i.test(absoluteUrl)
                                ? 0
                                : typeof playerMode === "number"
                                  ? playerMode
                                  : 0,
                        labels: {
                            loading: _("Loading..."),
                            playback: _("Stream could not be played"),
                            runtime: _(
                                "Compatibility runtime could not load. Reopen the player to retry."
                            ),
                            startup: _("Player could not start"),
                        },
                        loop: demo,
                        requestId: id,
                        url: absoluteUrl,
                    };
                },
                seed: Date.now() * 1000,
                serial: false,
            }),
            pipBounds: bounds,
        });
    })();
}
window.setSleepTimeout = setSleepTimeout;
// Input editors must be on window: setEditor / first-run / settings typeof checks
// mirror monolith bare-function typeof after classic-script concat. Module exports
// alone are not visible as window.showEditKey2.
window.editKey1 = editKey1;
window.editKey2 = editKey2;
window.showEditKey1 = showEditKey1;
window.showEditKey2 = showEditKey2;
window.setEditor = setEditor;
// Apply immediately so window.showEditKey is not left on the ui-module default
// (showEditKey1) if onStbReady is delayed or an early edit path runs first.
try {
    setEditor();
} catch (_e) {
    /* settings / stbGetItem may not be ready yet; onStbReady calls setEditor again */
}
window.setColor = setColor;
window.setListPos = setListPos;

// Keep list chrome (#listIn left/width, fonts, colors) in sync when the
// frameless window is resized or restored by tauri-plugin-window-state.
if (typeof window !== "undefined" && !(window as any).__ottListResizeBound) {
    (window as any).__ottListResizeBound = true;
    var __ottListResizeTimer: any = null;
    window.addEventListener("resize", function () {
        if (__ottListResizeTimer) clearTimeout(__ottListResizeTimer);
        __ottListResizeTimer = setTimeout(function () {
            try {
                if (typeof (window as any).setListPos === "function")
                    (window as any).setListPos();
                if (typeof (window as any).setFontSize === "function")
                    (window as any).setFontSize();
                if (typeof (window as any).setColor === "function")
                    (window as any).setColor();
                // Prefer live overlay visibility — bare window.isListVisible can
                // lag the module flag after window-state restore, leaving rows
                // sized for the previous innerHeight (~21 of pageSize 25).
                var listOpen = !!(window as any).isListVisible;
                try {
                    if (typeof (window as any).$ !== "undefined") {
                        var $w = (window as any).$;
                        listOpen =
                            listOpen ||
                            $w("#list_window").is(":visible") ||
                            $w("#list_osd").is(":visible") ||
                            ($w("#list").is(":visible") &&
                                $w("#listIn").children().length > 0);
                    }
                } catch (_vis) {}
                if (listOpen && typeof (window as any).showPage === "function")
                    (window as any).showPage();
            } catch (_eResize) {}
        }, 120);
    });
}

window.setFontSize = setFontSize;
window.setTimezone = setTimezone;
window.saveListPanelState = saveListPanelState;
window.restoreListPanelState = restoreListPanelState;
window.getMacAddress = getMacAddress;
// sendClientFeedback and queueFeedbackPost from helpers.ts already global
window.ottpStorage = storage;
window.lzstring = {
    compress: (window as any).compress,
    compressToBase64: (window as any).compressToBase64,
    compressToEncodedURIComponent: (window as any)
        .compressToEncodedURIComponent,
    compressToUint8Array: (window as any).compressToUint8Array,
    compressToUTF16: (window as any).compressToUTF16,
    decompress: (window as any).decompress,
    decompressFromBase64: (window as any).decompressFromBase64,
    decompressFromEncodedURIComponent: (window as any)
        .decompressFromEncodedURIComponent,
    decompressFromUint8Array: (window as any).decompressFromUint8Array,
    decompressFromUTF16: (window as any).decompressFromUTF16,
};
window.channels = channels;
window.cats = cats;
window.catsArray = catsArray;
window.curList = curList;
window.catIndex = catIndex;
window.primaryIndex = primaryIndex;
window.prevArr = prevArr;
window.favoritesArray = favoritesArray;
window.parentalArray = parentalArray;
window.playType = playType;
window.playTime = playTime;
window.settings = settings;
window.exportSettings = exportSettings;
window.importSettings = importSettings;
window.parentPIN = parentPIN;
window.hideMenus = hideMenus;
window.pageSize = pageSize;
window.listDataArray = listDataArray;
window.listSelectionIndex = listSelectionIndex;
window.popupActions = popupActions;
window.popupList = popupList;
window.toggleProviderSettingsVisibility = toggleProviderSettingsVisibility;
window.popupArray = popupArray;
window.popupDetail = popupDetail;
window.pipIndex = pipIndex;
window.pipCatIndex = pipCatIndex;
window.previewChan = previewChan;
window.playerModeNames = playerModeNames;
window.setPlayerMode = setPlayerMode;
window.stbIsStandby = stbIsStandby;
window.stbSetStandby = stbSetStandby;
window.bufferSizes = bufferSizes;
window.colorDialog = colorDialog;
window.selColorDialog = selColorDialog;
window.backColorDialog = backColorDialog;
window.optionsList = optionsList;
window.restart = restart;
window.formatSeekOffset = formatSeekOffset;
window.noop = noop;
window.toggleAspectRatio = toggleAspectRatio;
window.toggleZoom = toggleZoom;
window.toggleAudioTrack = toggleAudioTrack;
window.toggleSubtitle = toggleSubtitle;
window.popPrevProg = popPrevProg;
window.popPause = popPause;
window.popStop = popStop;
window.popShift = popShift;
window.popTogglePip = popTogglePip;
window.popStopPip = popStopPip;
window.popBuckets = popBuckets;
window.popEpg = popEpg;
window.popRecords = popRecords;
window.popMedia = popMedia;
window.exitPortal = exitPortal;
/* ---------------------------------------------------------------------------
 * Info list items (About screen)
 * --------------------------------------------------------------------------- */
/**
 * Display the "About" / plugin info screen.
 * Shows player version, HTTPS support status, OTT host, and
 * device info (via stbInfo).
 *
 * Side effects: Saves CPD; writes to #listAbout; calls stbInfo() if
 * available; sets aboutKeyHandler to dismiss on any key.
 */
function pluginInfo(): void {
    var v = (window as any).version || "<br/>Version: " + PLAYER_VERSION;
    v = v.replace(
        /(^|<br\s*\/?>)Version: /g,
        function (_match: string, prefix: string) {
            return prefix + _("Version") + ": ";
        }
    );
    var host = (window as any).host || "-";
    var canHttps = _((window as any).client_can_https ? "Yes" : "No");
    var html =
        _("Player info:") +
        "<br/>" +
        v +
        "<br/>" +
        _("HTTPS support") +
        ": " +
        canHttps +
        "<br/>" +
        _("OTT / APP host") +
        ": " +
        host +
        " / " +
        window.location.host +
        "<br/><br/>" +
        _("Device info:") +
        "<br/>";
    (window as any).saveListPanelState();
    $("#listAbout").show().html(html);
    if (typeof (window as any).stbInfo === "function")
        (window as any).stbInfo();
    (window as any).aboutKeyHandler = function () {
        return false;
    };
}

/** Readable with a remote or pointer; attribution remains available offline. */
function interfaceCredits(): void {
    var w = window as any;
    w.saveListPanelState();
    $("#listCaption").text(_("Interface credits"));
    $("#listAbout").html($("#interfaceCreditsSource").html()).show();
    $("#listAbout .credits-title").text(_("Interface credits"));
    $("#listAbout .credits-navigation").text(
        _("Use Up / Down to scroll. Back to close.")
    );
    $("#listAbout .credits-language").text(
        _("Original text: %1", _("English"))
    );
    $("#listAbout .credits-history").text(
        _("Full history, sources and license terms")
    );
    $("#listPodval").html(renderButtonHint(keys.RETURN, strRETURN, "Close"));
    w.aboutKeyHandler = function (key: number): boolean {
        if (key === w.keys.RETURN || key === w.keys.EXIT) {
            $("#listAbout").hide().empty();
            w.restoreListPanelState();
            w.aboutKeyHandler = null;
        } else if (key === w.keys.UP || key === w.keys.DOWN) {
            var content = $("#listAbout .interface-credits")[0];
            if (content) content.scrollTop += key === w.keys.UP ? -80 : 80;
        }
        return true;
    };
}

/** Read the policy bundled with this Android installation, without a network service. */
function privacyPolicy(onClose?: () => void): void {
    var w = window as any;
    var previousHandler = w.aboutKeyHandler;
    var closed = false;
    var panel = $("#listAbout");
    if (typeof w.saveListPanelState === "function") w.saveListPanelState();
    panel.empty().show();
    var close = function (): void {
        if (closed) return;
        closed = true;
        panel.hide().empty();
        w.aboutKeyHandler = previousHandler;
        if (typeof w.restoreListPanelState === "function")
            w.restoreListPanelState();
        if (typeof onClose === "function") onClose();
    };
    $("<button type='button'>")
        .text(_("Back"))
        .on("click", function (event: any) {
            event.stopPropagation();
            close();
        })
        .appendTo(panel);
    $("<p>")
        .text(_("Original text: %1", _("English")))
        .appendTo(panel);
    var content = $("<pre>")
        .attr("lang", "en")
        .css({
            fontFamily: "inherit",
            fontSize: "0.75em",
            height: "85%",
            overflow: "auto",
            touchAction: "pan-y",
            whiteSpace: "pre-wrap",
        })
        .text(_("Loading..."))
        .appendTo(panel);
    w.aboutKeyHandler = function (key: number): boolean {
        if (
            key === w.keys.RETURN ||
            key === w.keys.EXIT ||
            key === w.keys.ENTER
        )
            close();
        else if (key === w.keys.DOWN)
            content.scrollTop(content.scrollTop() + 100);
        else if (key === w.keys.UP)
            content.scrollTop(content.scrollTop() - 100);
        return true;
    };
    $.get(
        (w.host || "") + "/privacy-policy.txt",
        function (text: string) {
            if (!closed) content.text(text);
        },
        "text"
    ).fail(function () {
        if (!closed)
            content.text(
                _(
                    "Privacy policy unavailable. Contact: %1",
                    "alvit.work@gmail.com"
                )
            );
    });
}
window.privacyPolicy = privacyPolicy;

/**
 * Display the "Remote control buttons description" screen.
 * Lists all remote button functions for live and archive modes, with
 * labelled key icons. Auto-scrolls long content.
 *
 * Side effects: Saves CPD; writes to #listAbout; calls scrollUp();
 * sets aboutKeyHandler to dismiss on RETURN.
 */
function buttonsInfo(): void {
    var e = '<br/><div class="btn">';
    var t = "</div> - ";
    var strYellow = (window as any).strTools || "";
    var strRed = (window as any).strEPG || "";
    var html =
        e +
        (window as any).strENTER +
        t +
        _("Show channel selection list") +
        e +
        (window as any).strRETURN +
        t +
        _("Hide / Return") +
        e +
        (window as any).strEXIT +
        t +
        _("Exit player") +
        "<br/><br/>" +
        _("In live mode: <br/>") +
        e +
        (window as any).strSTOP +
        t +
        _("Restart stream") +
        e +
        (window as any).strPLAY +
        " / " +
        (window as any).strPAUSE +
        " / 0" +
        t +
        _("Pause/Play") +
        e +
        (window as any).strPREV +
        t +
        _("Timeshift: to start of TV program") +
        e +
        (window as any).strRW +
        t +
        _("Timeshift: one minute back") +
        e +
        (window as any).strFF +
        " / " +
        (window as any).strNEXT +
        t +
        _("Show rewind window") +
        _("<br/><br/>In archive mode:<br/>") +
        e +
        (window as any).strPLAY +
        " / " +
        (window as any).strPAUSE +
        " / 0" +
        t +
        _("Pause/Play") +
        e +
        (window as any).strSTOP +
        " / 8" +
        t +
        _("Stop playback and return to live") +
        e +
        (window as any).strPREV +
        " / 2" +
        t +
        _("To start of TV program / Previous TV program") +
        e +
        (window as any).strNEXT +
        " / 5" +
        t +
        _("Next TV program") +
        e +
        (window as any).strRW +
        " / " +
        (window as any).strFF +
        t +
        _("Back / Forward for 1 minute") +
        (strYellow ? "<br/>" + e + strYellow + t + _("Show player menu") : "") +
        (strRed
            ? "<br/>" + e + strRed + t + _("Show EPG and archive for channel")
            : "");
    (window as any).saveListPanelState();
    $("#listAbout")
        .html('<div id="_prd">' + html + "</div>")
        .show();
    var a = $("#_prd").height() + 10 - $("#listAbout").height();
    (window as any).scrollUp("_prd", a, 10000);
    (window as any).aboutKeyHandler = function (e: number): boolean {
        if (
            e === (window as any).keys.RETURN ||
            e === (window as any).keys.EXIT
        ) {
            (window as any).restoreListPanelState();
            $("#listAbout").hide().text("");
            clearTimeout((window as any).detailTimer);
        }
        return true;
    };
}

function toggleDebugHudInfo(): void {
    if (
        (window as any).__ottDebug &&
        typeof (window as any).__ottDebug.toggleHud === "function"
    ) {
        (window as any).__ottDebug.toggleHud();
    } else {
        (window as any).infoBox(_("Debug HUD is not available"));
    }
}

function editBackupStreams(): void {
    if ((window as any).__ottStreamPolicy)
        (window as any).__ottStreamPolicy.edit(editSettingsText);
}
function audioVideoTest(): void {
    var test = (window as any).__ottAvTest;
    if (!test) return;
    showSelectBox(
        0,
        [_("Play"), _("Stop")],
        function (selected: number) {
            if (selected === 0 && !test.start())
                showShift(_("Stream could not be played"));
            else if (selected === 1) test.stop();
        },
        -1
    );
}
var infoArr: any[] = [
    { action: audioVideoTest, name: "Audio" },
    { action: editBackupStreams, name: "Backup streams" },
    { action: buttonsInfo, name: "Description of remote control buttons" },
    { action: noop },
    { action: pluginInfo, desc: "Player and device info", name: "About" },
    {
        action: interfaceCredits,
        name: "Interface credits",
    },
    {
        action: toggleDebugHudInfo,
        desc: "Toggle on-screen debug HUD",
        name: "Debug HUD",
    },
];
if (
    (window as any).Capacitor ||
    (window as any).__TAURI__ ||
    (window as any).__OTTPLAY_HOSTED__
) {
    infoArr.push({
        action: function () {
            (window as any).__ottGuideBindings.open();
        },
        desc: "Edit",
        name: "EPG",
    });
}
if ((window as any).__OTTPLAY_HOSTED__) {
    infoArr.push({
        action: function () {
            (window as any).__ottHostedEpg.showDiagnostics();
        },
        name: "EPG diagnostics",
    });
}
if (isPlayDistribution()) {
    infoArr.push({
        action: function () {
            privacyPolicy();
        },
        name: "Privacy policy",
    });
}

window.infoArr = infoArr;
window.pluginInfo = pluginInfo;
window.buttonsInfo = buttonsInfo;
window.toggleDebugHudInfo = toggleDebugHudInfo;
window.infoList = infoList;
// Resolve the initial host actions now that callable ports are published.
var resolvedMenu = (window as any).__ottMenuRegistry.defaults(window as any);
popupActions.splice.apply(
    popupActions,
    [0, popupActions.length].concat(resolvedMenu.actions) as any
);

window.isListVisible = isListVisible;
window.editValue = editValue;
window.curColor = curColor;
window.curColorB = curColorB;
window.bodyColor = bodyColor;
window.epgCache = epg;
window.medHistory = medHistory;
window.medFavorites = medFavorites;
window.channelAspects = aAspects;
window.channelZooms = aZooms;
window.channelAudios = aAudios;
window.channelSubs = aSubs;
window.strEXIT = strEXIT;
window.strENTER = strENTER;
window.strTools = strTools;
window.strInfo = strInfo;
window.strEPG = strEPG;
window.strPip = strPip;
window.strAspect = strAspect;
window.strZoom = strZoom;
window.strAudio = strAudio;
window.strPrech = strPRECH;
window.strRETURN = strRETURN;
window.strSETUP = strSETUP;
window.strLANG = strLANG;
window.strUP = strUP;
window.strDOWN = strDOWN;
window.strLEFT = strLEFT;
window.strRIGHT = strRIGHT;
window.strSTOP = strSTOP;
window.strPLAY = strPLAY;
window.strPAUSE = strPAUSE;
window.strPlayPause = strPlayPause;
window.strRW = strRW;
window.strFF = strFF;
window.strPREV = strPREV;
window.strNEXT = strNEXT;
window.strSubt = strSubt;
window.strNew = strNew;
// @legacy-bridge: TMDb.prepare + TMDb.search called by src/ui/index.js (concatenated
// into dist/player.js). Provider scripts may extend TMDb with their own .search().
window.TMDb = TMDb;
// NOTE: __cv/__av are set by index.html (lines 144-145) BEFORE dist/player.js
// loads. Provider scripts (src/provider/index.ts) read them as bare globals. Do
// not re-assign here — the HTML-injected values win.
window.version = "<br/>Version: " + PLAYER_VERSION;

// Command handler (push commands via webhook)
window.handleCommand = handleCommand;
window.showPopup = showPopup;

// HTTP control is activated only by this device's explicit saved consent.
(window as any).__ottLocalHttpRemote = createLocalHttpRemote(
    window,
    async function (enabled: boolean, code: string): Promise<any> {
        if (typeof window.__TAURI__ !== "undefined") {
            return tauriInvoke("queue_http_configure", {
                enabled: enabled,
                token: code,
            });
        }
        var capacitor = (window as any).Capacitor;
        if (capacitor) {
            var plugin =
                capacitor.Plugins && capacitor.Plugins.MobileCommandQueue;
            if (!plugin)
                throw new Error("HTTP remote control could not be started");
            if (!enabled) {
                await plugin.stop();
                return { httpEnabled: false, port: 0, running: false };
            }
            return plugin.start({ httpEnabled: true, token: code });
        }
        // Mode A polls the separately configured, authenticated local proxy.
        return { httpEnabled: enabled, port: 0, running: enabled };
    },
    function (enabled: boolean, code: string): void {
        // Consent is revoked durably before credentials can be changed.
        if (
            !saveSettings({ localHttpEnabled: 0 }) ||
            !saveSettings({
                localHttpDeviceCode: code,
                localHttpEnabled: enabled ? 1 : 0,
            })
        )
            throw new Error("HTTP remote settings could not be saved");
    }
);

(window as any).__ottKiosk = createKiosk(window);
bindKioskScreen(window);
var remoteInspection = installRemoteInspection(window);

// Runtime authority follows the actual connection, even when saved preferences cannot be updated.
var remoteControlConnection: {
    address: string;
    enabled: boolean;
    token: string;
} = {
    address: "",
    enabled: false,
    token: "",
};
function remoteControlConfig(): {
    address: string;
    enabled: boolean;
    token: string;
} {
    return {
        address: remoteControlConnection.address,
        enabled: remoteControlConnection.enabled,
        token: remoteControlConnection.token,
    };
}

var runtimeDiagnostics = resolveNativePlugin<any>(
    "RuntimeDiagnostics",
    function () {
        return {
            snapshot: function () {
                return Promise.reject(new Error("unavailable"));
            },
        };
    }
);
(window as any).__ottRuntimeDebug = installRuntimeDebug(window, {
    getConfig: remoteControlConfig,
    native: function () {
        return typeof window.__TAURI__ !== "undefined"
            ? tauriInvoke("runtime_diagnostics", {})
            : runtimeDiagnostics.snapshot();
    },
    runtime: function () {
        return remotePlayerInfo(window).runtime;
    },
});

// Outbound server credentials are entered on this installation, never generated by a listener.
(window as any).__ottCommandServer = createCommandServer(
    window,
    createCommandServerTransport(
        window,
        typeof window.__TAURI__ !== "undefined"
            ? function (request: any): Promise<any> {
                  return tauriInvoke("proxy_http", request);
              }
            : (window as any).Capacitor &&
                (!(window as any).Capacitor.isNativePlatform ||
                    (window as any).Capacitor.isNativePlatform())
              ? function (request: any): Promise<any> {
                    return StalkerPortal.httpRequest(request);
                }
              : undefined,
        typeof window.__TAURI__ === "undefined" &&
            (window as any).Capacitor &&
            (!(window as any).Capacitor.isNativePlatform ||
                (window as any).Capacitor.isNativePlatform()) &&
            typeof StalkerPortal.cancelHttpRequest === "function"
            ? function (requestId: string): void {
                  StalkerPortal.cancelHttpRequest!({
                      requestId: requestId,
                  }).catch(function () {});
              }
            : undefined
    ),
    function (config: any): void {
        remoteControlConnection = {
            address: config.address,
            enabled: false,
            token: config.token,
        };
        try {
            if (
                !saveSettings({ commandServerEnabled: 0 }) ||
                !saveSettings({
                    commandServerAddress: config.address,
                    commandServerEnabled: config.enabled ? 1 : 0,
                    commandServerToken: config.token,
                })
            )
                throw new Error("Command server settings could not be saved");
            remoteControlConnection.enabled = config.enabled === true;
        } finally {
            // A failed first write may leave enabled saved preferences; runtime authority still stays off.
            if ((window as any).__ottRemoteDiagnostics)
                (window as any).__ottRemoteDiagnostics.configurationChanged(
                    remoteControlConfig()
                );
            if ((window as any).__ottRemoteScreenshot)
                (window as any).__ottRemoteScreenshot.configurationChanged();
            if ((window as any).__ottRuntimeDebug)
                (window as any).__ottRuntimeDebug.configurationChanged();
        }
    },
    handleCommand,
    function (request, done, afterReply) {
        // This callback is reached only from a live authenticated server delivery.
        return remoteInspection.execute(
            request,
            done,
            afterReply,
            function (item, reply, defer) {
                if (item.action === "kiosk") {
                    (window as any).__ottKiosk.request(item.params, reply);
                    return;
                }
                return executeRemoteRequest(item, reply, defer);
            }
        );
    },
    remoteInspection.accept
);

installRemoteScreenshot(window, {
    getConfig: function () {
        return remoteControlConfig();
    },
    mobile: resolveNativePlugin<any>("RemoteScreenshot", function () {
        return {
            capabilities: function () {
                return Promise.resolve({ source: null, supported: false });
            },
            capture: function () {
                return Promise.reject(new Error("Screenshots unavailable"));
            },
        };
    }),
    onStatus: function (status: any): void {
        var badge = document.getElementById("remoteScreenshotIndicator");
        if (!status.enabled && !status.pending) {
            var controller = (window as any).__ottCommandServer;
            if (controller && controller.discardScreenshots)
                controller.discardScreenshots();
            if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
            return;
        }
        if (!status.browserSelectionSupported) {
            if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
            return;
        }
        if (!badge) {
            badge = document.createElement("button");
            badge.id = "remoteScreenshotIndicator";
            badge.style.cssText =
                "position:fixed;right:8px;bottom:8px;z-index:99999;" +
                "background:#532900;color:white;border:1px solid white;padding:6px;";
            badge.onclick = function (event) {
                event.preventDefault();
                event.stopPropagation();
                (window as any).__ottRemoteScreenshot.stop();
            };
            (document.body || document.documentElement).appendChild(badge);
        }
        badge.textContent = (window as any)._("Stop browser sharing");
    },
});

function initRemoteDiagnostics(): void {
    (window as any).__ottRemoteDiagnostics = installDiagnosticsController(
        window,
        {
            getConfig: function () {
                return remoteControlConfig();
            },
            onStatus: function (status: any): void {
                var badge = document.getElementById(
                    "remoteDiagnosticsIndicator"
                );
                if (!status.sessionId) {
                    if (badge && badge.parentNode)
                        badge.parentNode.removeChild(badge);
                    return;
                }
                if (!badge) {
                    badge = document.createElement("button");
                    badge.id = "remoteDiagnosticsIndicator";
                    badge.style.cssText =
                        "position:fixed;right:8px;top:8px;z-index:99999;max-width:70%;" +
                        "background:#532900;color:white;border:1px solid white;padding:6px;";
                    badge.onclick = function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        (window as any).__ottRemoteDiagnostics.stopSession();
                    };
                    (document.body || document.documentElement).appendChild(
                        badge
                    );
                }
                badge.textContent =
                    (window as any)._("Remote diagnostics") +
                    ": " +
                    (window as any)._(status.message) +
                    " · " +
                    (window as any)._("Stop current capture");
            },
            runtimeLabel:
                (typeof window.__TAURI__ !== "undefined"
                    ? "tauri"
                    : (window as any).Capacitor
                      ? "capacitor"
                      : (window as any).ott_device === "lg/webos"
                        ? "webos"
                        : "browser") +
                "." +
                (/^[A-Za-z0-9_.-]{1,24}$/.test(PLAYER_VERSION)
                    ? PLAYER_VERSION
                    : "development"),
            send: createCommandServerTransport(
                window,
                typeof window.__TAURI__ !== "undefined"
                    ? function (request: any): Promise<any> {
                          return tauriInvoke("proxy_http", request);
                      }
                    : (window as any).Capacitor &&
                        (!(window as any).Capacitor.isNativePlatform ||
                            (window as any).Capacitor.isNativePlatform())
                      ? function (request: any): Promise<any> {
                            return StalkerPortal.httpRequest(request);
                        }
                      : undefined
            ),
        }
    );
}

(window as any).__ottControlDiscovery = createControlDiscovery(
    window,
    createCommandServerTransport(
        window,
        typeof window.__TAURI__ !== "undefined"
            ? function (request: any): Promise<any> {
                  return tauriInvoke("proxy_http", request);
              }
            : undefined
    ),
    function () {
        return {
            address: settings.commandServerAddress,
            enabled: settings.commandServerEnabled === 1,
            generation: (window as any).__ottCommandServer.status().generation,
            token: settings.commandServerToken,
        };
    },
    function (config: any) {
        (window as any).__ottCommandServer.configure(config);
        if (!(window as any).__ottCommandServer.status().enabled)
            throw new Error("Approved command server could not be configured");
    },
    function () {
        return String((window as any).deviceUUID || "");
    },
    typeof window.__TAURI__ !== "undefined"
        ? function (): Promise<any> {
              return tauriInvoke("discover_control_servers", {});
          }
        : undefined
);
(window as any).__OTT_CONTROL_DISCOVERY_VERSION__ = 1;

// Tauri Mode B: poll the native command queue (queue_poll invoke) instead of
// the local_proxy.py GET endpoint. Mirrors the STB poll cadence (~10s) so
// push commands (popup_message, channel switches, …) arrive promptly.
// Mode A (browser/STB): untouched — local_proxy.py on :8081 handles polling.
if (typeof window.__TAURI__ !== "undefined") {
    let _queuePollTimer: ReturnType<typeof setInterval> | null = null;
    const _queuePollOnce = (): void => {
        var status = (window as any).__ottLocalHttpRemote.status();
        if (!status.ready) return;
        var revision = status.generation;
        var device = String((window as any).deviceUUID || "");
        Promise.all(
            (device ? ["", device] : [""]).map(function (id) {
                return tauriInvoke<any[]>("queue_poll", { deviceId: id });
            })
        )
            .then((batches: any[][]) => {
                var current = (window as any).__ottLocalHttpRemote.status();
                if (!current.ready || current.generation !== revision) return;
                var cmds: any[] = [].concat.apply([], batches as any);
                if (Array.isArray(cmds)) {
                    cmds.forEach((cmd: any) => {
                        if (cmd && typeof handleCommand === "function") {
                            try {
                                handleCommand(cmd as Command);
                            } catch (_e) {
                                console.warn(
                                    "[queue_poll] handleCommand failed:",
                                    _e
                                );
                            }
                        }
                    });
                }
            })
            .catch((e: any) => console.warn("[queue_poll] poll failed:", e));
    };
    const _queuePollStart = (): void => {
        if (_queuePollTimer) return;
        _queuePollOnce(); // immediate first drain
        _queuePollTimer = setInterval(_queuePollOnce, 10000);
    };
    const _queuePollStop = (): void => {
        if (_queuePollTimer) {
            clearInterval(_queuePollTimer);
            _queuePollTimer = null;
        }
    };
    (window as any).__ottQueuePoll = {
        poll: _queuePollOnce,
        start: _queuePollStart,
        stop: _queuePollStop,
    };
    // Auto-start once the player is ready.
    _queuePollStart();
}

// Capacitor Mode C: internal bridge polling does not enable HTTP control.
// Falls back to web no-op if plugin unavailable (Mode A / web build).
if (
    typeof (window as any).Capacitor !== "undefined" &&
    (window as any).Capacitor.Plugins
) {
    const _capQueue = (window as any).Capacitor.Plugins.MobileCommandQueue;
    if (_capQueue) {
        // Capacitor Mode C: drain via native plugin `get()` only.
        // Do NOT set local_poll_url — that would also trigger the HTTP loopback poller.
        let _capPollTimer: ReturnType<typeof setInterval> | null = null;
        const _capPollOnce = async (): Promise<void> => {
            try {
                var status = (window as any).__ottLocalHttpRemote.status();
                if (!status.ready) return;
                var revision = status.generation;
                var device = String((window as any).deviceUUID || "");
                const batches = await Promise.all(
                    (device ? ["", device] : [""]).map(function (id) {
                        return _capQueue.get({ deviceId: id });
                    })
                );
                var current = (window as any).__ottLocalHttpRemote.status();
                if (!current.ready || current.generation !== revision) return;
                const cmds: any[] = [];
                batches.forEach(function (res: any) {
                    if (res && Array.isArray(res.commands))
                        Array.prototype.push.apply(cmds, res.commands);
                });
                if (Array.isArray(cmds)) {
                    cmds.forEach((cmd: any) => {
                        if (cmd && typeof handleCommand === "function") {
                            try {
                                handleCommand(cmd as Command);
                            } catch (_e) {
                                console.warn(
                                    "[cap_queue] handleCommand failed:",
                                    _e
                                );
                            }
                        }
                    });
                }
            } catch (e) {
                console.warn("[cap_queue] poll failed:", e);
            }
        };
        const _capPollStart = async (): Promise<void> => {
            if (_capPollTimer) return;
            try {
                await _capQueue.start();
            } catch (_e) {
                console.warn("[cap_queue] start failed:", _e);
            }
            await _capPollOnce();
            _capPollTimer = setInterval(() => {
                _capPollOnce();
            }, 10000);
        };
        const _capPollStop = (): void => {
            if (_capPollTimer) {
                clearInterval(_capPollTimer);
                _capPollTimer = null;
            }
            _capQueue.stop?.();
        };
        (window as any).__ottCapQueue = {
            poll: _capPollOnce,
            start: _capPollStart,
            stop: _capPollStop,
        };
        _capPollStart();
    }
}

/**
 * Show the "Remote control" settings screen.
 * Configure outbound command polling and local remote-control options.
 * Saving a complete server connection starts polling immediately.
 *
 * Side effects: Writes to #listAbout; sets listKeyHandlerFn for ENTER/RETURN.
 */
window.settingsCommands = function (): void {
    var w = window as any;
    var commandServer = w.__ottCommandServer;
    var discovery = w.__ottControlDiscovery;
    var diagnostics = w.__ottRemoteDiagnostics;
    var screenshots = w.__ottRemoteScreenshot;
    function refreshScreenshots(): void {
        if (!screenshots || closed) return;
        var view = screenshots.status();
        var label = document.getElementById("remoteScreenshotStatus");
        if (label)
            label.textContent =
                view.state === "unsupported"
                    ? w._("Screenshots are unavailable on this platform.")
                    : w._(view.message);
        var button = document.getElementById(
            "remoteScreenshotToggle"
        ) as HTMLButtonElement | null;
        if (button) {
            button.hidden = !view.browserSelectionSupported;
            button.disabled =
                !view.browserSelectionSupported || !view.connected;
            button.textContent = w._(
                view.enabled || view.pending
                    ? "Stop browser sharing"
                    : "Select screenshot source in browser"
            );
        }
    }
    function refreshDiagnostics(): void {
        if (!diagnostics || closed) return;
        var status = diagnostics.status();
        var label = document.getElementById("remoteDiagnosticsStatus");
        if (label)
            label.textContent =
                w._(status.message) +
                (status.runtimeId ? " · " + status.runtimeId : "");
        var stopSession = document.getElementById(
            "remoteDiagnosticsStopSession"
        ) as HTMLButtonElement | null;
        if (stopSession) stopSession.disabled = !status.sessionId;
    }
    function refreshDiscovery(): void {
        if (!discovery || closed) return;
        var status = discovery.status();
        var label = document.getElementById("commandServerDiscoveryStatus");
        if (label)
            label.textContent =
                w._(status.message, status.messageArgument) +
                (status.code ? " " + status.code : "");
        var cancel = document.getElementById(
            "commandServerDiscoveryCancel"
        ) as HTMLButtonElement | null;
        if (cancel)
            cancel.disabled = !/^(discovering|choose|pairing|waiting)$/.test(
                status.state
            );
        var choices = document.getElementById("commandServerDiscoveryChoices");
        if (!choices) return;
        choices.textContent = "";
        controls.length = Math.min(controls.length, 11);
        controlActions.length = Math.min(controlActions.length, 11);
        status.servers.forEach(function (server: any, index: number) {
            var button = document.createElement("button");
            button.textContent =
                server.address +
                (server.domain ? " (" + server.domain + ")" : "");
            choices!.appendChild(button);
            var at = controlActions.length;
            controlActions.push(function () {
                discovery.choose(index);
            });
            bindControl(button, at);
        });
        if (selectedControl >= controls.length) selectControl(3, false);
    }
    function refreshServerStatus(): void {
        if (!commandServer) return;
        var address = document.getElementById("commandServerAddressValue");
        if (address)
            address.textContent =
                settings.commandServerAddress || w._("not set");
        var tokenPresence = document.getElementById(
            "commandServerTokenPresence"
        );
        if (tokenPresence)
            tokenPresence.textContent = w._(
                settings.commandServerToken ? "saved on this device" : "not set"
            );
        var status = commandServer.status();
        var label = document.getElementById("commandServerStatus");
        var message = status.message;
        if (status.state === "disconnected") {
            if (!settings.commandServerAddress)
                message = "Enter the command server IP or address.";
            else if (!settings.commandServerToken)
                message = "Enter this player's device access code to connect.";
        }
        if (label) label.textContent = w._(message);
        var button = document.getElementById("commandServerConnectLabel");
        if (button)
            button.textContent = w._(status.enabled ? "Disconnect" : "Connect");
    }
    if (commandServer) commandServer.subscribe(refreshServerStatus);
    if (discovery) discovery.subscribe(refreshDiscovery);
    if (diagnostics) diagnostics.subscribe(refreshDiagnostics);
    var changingHttpRemote = false;
    var httpRemoteError = false;
    var closed = false;
    var selectedControl = w.sNoNumbersKeys ? 0 : -1;
    var controls: HTMLElement[] = [];
    var controlActions = [
        function (): void {
            editServer(false);
        },
        function (): void {
            editServer(true);
        },
        toggleServer,
        function (): void {
            if (discovery) discovery.start(true);
        },
        function (): void {
            editUrl(false);
        },
        function (): void {
            editUrl(true);
        },
        toggleHttpRemote,
        close,
        function (): void {
            if (discovery) discovery.cancel();
        },
        function (): void {
            if (diagnostics && diagnostics.status().sessionId)
                diagnostics.stopSession();
            refreshDiagnostics();
        },
        function (): void {
            if (screenshots && !w.__ottRemoteInputActive) {
                var view = screenshots.status();
                if (view.enabled || view.pending) screenshots.stop();
                else screenshots.selectSource(true);
            }
            refreshScreenshots();
        },
    ];
    var parent = ["listCaption", "listDetail", "listPodval"].map(function (id) {
        var element = document.getElementById(id);
        return element ? element.innerHTML : "";
    });
    if (typeof w.ensureDeviceClientId === "function") w.ensureDeviceClientId();
    var uid = w.deviceUUID || "";
    if (!uid) {
        try {
            uid =
                w.localStorage.getItem("ott_device_uuid") ||
                w.localStorage.getItem("deviceId");
        } catch (_error) {}
    }
    uid = uid || "not generated";

    function text(value: any): string {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function selectControl(index: number, focus: boolean): void {
        selectedControl = index;
        for (var i = 0; i < controls.length; i++) {
            controls[i].style.outline =
                i === index ? "2px solid currentColor" : "";
            controls[i].style.outlineOffset = i === index ? "2px" : "";
        }
        if (focus && controls[index]) controls[index].focus();
    }
    function bindControl(element: HTMLElement, index: number): void {
        controls[index] = element;
        element.tabIndex = 0;
        element.onclick = function (event): void {
            event.stopPropagation();
            selectControl(index, false);
            controlActions[index]();
        };
        element.onfocus = function (): void {
            selectControl(index, false);
        };
        element.onkeydown = function (event): void {
            var key =
                typeof w.stbEventToKeyCode === "function"
                    ? w.stbEventToKeyCode(event)
                    : event.keyCode;
            if (
                key === w.keys.ENTER ||
                key === w.keys.LEFT ||
                key === w.keys.RIGHT ||
                key === w.keys.UP ||
                key === w.keys.DOWN
            ) {
                event.preventDefault();
                event.stopPropagation();
                w.aboutKeyHandler(key);
            }
        };
    }
    function close(): void {
        closed = true;
        if (commandServer) commandServer.subscribe(null);
        if (discovery) discovery.subscribe(null);
        if (diagnostics) diagnostics.subscribe(null);
        if (screenshots) screenshots.subscribe(null);
        $("#listAbout").hide().text("");
        ["listCaption", "listDetail", "listPodval"].forEach(
            function (id, index) {
                var element = document.getElementById(id);
                if (element) element.innerHTML = parent[index];
            }
        );
        w.optionsList(w.settingsCommands);
    }

    // Refresh content after an edit without overwriting the saved parent screen.
    function render(): void {
        if (closed) return;
        var remote = w.__ottLocalHttpRemote;
        var remoteStatus =
            remote && typeof remote.status === "function"
                ? remote.status()
                : { code: "", enabled: false, port: 0 };
        var caption = document.getElementById("listCaption");
        var detail = document.getElementById("listDetail");
        var footer = document.getElementById("listPodval");
        if (caption) caption.textContent = w._("Remote control");
        if (detail) detail.textContent = "";
        if (footer)
            footer.innerHTML =
                w.renderButtonHint(w.keys.RETURN, w.strRETURN, "Close") +
                w.renderButtonHint(w.keys.ENTER, w.strENTER, "Local URL") +
                w.renderButtonHint(w.keys.N2 || 50, "2", "Swop URL") +
                w.renderButtonHint(
                    w.keys.N1 || 49,
                    "1",
                    remoteStatus.enabled
                        ? "Disable HTTP remote"
                        : "Enable HTTP remote"
                ) +
                '<span style="white-space:nowrap;">' +
                text(w._("↑↓ Scroll")) +
                "</span>";
        var lurl = w.sLocalCmdUrl || "";
        var swopUrl = w.sSwopBaseUrl || "";
        var html =
            '<div id="remoteSettingsContent" style="height:100%;min-height:0;min-width:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;overflow-wrap:anywhere;word-break:break-word;-webkit-overflow-scrolling:touch;">' +
            "<b>" +
            text(w._("Command server")) +
            "</b><br/>" +
            text(
                w._(
                    "Enter the server IP or address and this player's device access code from the server configuration. Saving both starts checking for volume, channel and other commands automatically."
                )
            ) +
            "<br/>" +
            text(
                w._(
                    "An IP without a port uses HTTP port 8081. Clear the address or select Disconnect to stop."
                )
            ) +
            "<br/>" +
            text(
                w._(
                    "Use LEFT/RIGHT to select a control, OK to activate, and UP/DOWN to scroll."
                )
            ) +
            "<br/>" +
            "<b>" +
            text(w._("Server address")) +
            ':</b> <span id="commandServerAddressValue">' +
            text(settings.commandServerAddress || w._("not set")) +
            "</span><br/>" +
            "<b>" +
            text(w._("Access code")) +
            ':</b> <span id="commandServerTokenPresence">' +
            text(
                w._(
                    settings.commandServerToken
                        ? "saved on this device"
                        : "not set"
                )
            ) +
            "</span><br/>" +
            "<b>" +
            text(w._("Status")) +
            ':</b> <span id="commandServerStatus"></span><br/>' +
            '<button id="commandServerAddress"><span class="btn">3</span> ' +
            text(w._("Server address")) +
            "</button> " +
            '<button id="commandServerToken"><span class="btn">4</span> ' +
            text(w._("Access code")) +
            "</button> " +
            '<button id="commandServerConnect"><span class="btn">5</span> <span id="commandServerConnectLabel">' +
            text(w._("Connect")) +
            "</span></button><br/><br/>" +
            '<button id="commandServerFind"><span class="btn">6</span> ' +
            text(w._("Find command server")) +
            '</button> <button id="commandServerDiscoveryCancel" disabled>' +
            text(w._("Cancel pairing")) +
            '</button><br/><span id="commandServerDiscoveryStatus" role="status"></span><div id="commandServerDiscoveryChoices"></div><br/>' +
            "<b>" +
            text(w._("Remote diagnostics")) +
            "</b><br/>" +
            text(
                w._(
                    "Connecting remote control authorizes this server to diagnose and repair the player. Access remains available after restarting and ends when you disconnect. Each diagnostic capture is limited to 10 minutes."
                )
            ) +
            '<br/><span id="remoteDiagnosticsStatus" role="status"></span><br/>' +
            '<button id="remoteDiagnosticsStopSession" disabled>' +
            text(w._("Stop current capture")) +
            "</button><br/><br/>" +
            "<b>" +
            text(w._("Remote screenshots")) +
            "</b><br/>" +
            text(
                w._(
                    "Remote control includes screenshots of the player, including settings. Images may contain private information. Native capture needs no extra approval. Browsers require a local choice of capture source."
                )
            ) +
            '<br/><span id="remoteScreenshotStatus" role="status"></span><br/>' +
            '<button id="remoteScreenshotToggle">' +
            text(w._("Select screenshot source in browser")) +
            "</button><br/><br/><b>" +
            text(w._("Local HTTP remote control")) +
            ":</b> " +
            text(w._(remoteStatus.enabled ? "on" : "off")) +
            "<br/>" +
            text(
                w._(
                    "Disabled by default. Enabling creates a new device access code."
                )
            ) +
            "<br/><br/>";
        if (remoteStatus.enabled && remoteStatus.code) {
            html +=
                "<b>" +
                text(w._("Device access code")) +
                ":</b><br/>" +
                '<input id="localHttpDeviceCode" type="text" readonly aria-label="' +
                text(w._("Device access code")) +
                '" value="' +
                text(remoteStatus.code) +
                '" style="width:100%;box-sizing:border-box;font-family:monospace;-webkit-user-select:text;user-select:text;"/><br/>' +
                text(
                    w._(
                        "Send this code from your proxy in the Authorization: Bearer header."
                    )
                ) +
                "<br/>" +
                text(w._("HTTP port")) +
                ": " +
                text(remoteStatus.port || "—") +
                "<br/><br/>";
        }
        if (
            changingHttpRemote ||
            httpRemoteError ||
            remoteStatus.error ||
            !remote
        ) {
            html +=
                '<div role="status">' +
                text(
                    w._(
                        changingHttpRemote
                            ? "Applying HTTP remote settings..."
                            : !remote
                              ? "HTTP remote control is unavailable on this device."
                              : "Could not update HTTP remote control."
                    )
                ) +
                "</div><br/>";
        }
        html +=
            '<b>Device ID (UUID):</b><br/><span style="font-family:monospace;">' +
            text(uid) +
            "</span><br/><br/>" +
            "This ID identifies your player for commands from Home Assistant or other automation. " +
            "Remote text entry (♥™) uses the configured relay server's installation authorization; this ID identifies the player, not a credential.<br/><br/>" +
            "<b>Local command URL:</b><br/>" +
            text(lurl || "not set (local command polling disabled)") +
            "<br/><br/>" +
            "<b>Remote text entry (swop) base URL:</b><br/>" +
            text(swopUrl || "not configured (♥™ no-op)") +
            "<br/><br/>" +
            "<b>Push commands (via webhook):</b><br/>" +
            "popup_message, channel_by_number, channel_by_name, random_channel, change_provider, change_provider_settings, change_playlist, set_volume, exit_player<br/><br/>" +
            text(
                w._(
                    "Use LEFT/RIGHT to select a control, OK to activate, and UP/DOWN to scroll."
                )
            ) +
            "</div>";
        $("#listAbout").show().html(html);
        // Trusted layout uses CSSOM so the native CSP does not drop inline styles.
        var content = document.getElementById("remoteSettingsContent");
        if (content) {
            content.style.height = "100%";
            content.style.minHeight = "0";
            content.style.minWidth = "0";
            content.style.boxSizing = "border-box";
            content.style.overflowY = "auto";
            content.style.overflowX = "hidden";
            content.style.wordBreak = "break-word";
        }
        controls = [];
        bindControl(document.getElementById("commandServerAddress")!, 0);
        bindControl(document.getElementById("commandServerToken")!, 1);
        bindControl(document.getElementById("commandServerConnect")!, 2);
        bindControl(document.getElementById("commandServerFind")!, 3);
        bindControl(
            document.getElementById("commandServerDiscoveryCancel")!,
            8
        );
        bindControl(
            document.getElementById("remoteDiagnosticsStopSession")!,
            9
        );
        refreshDiagnostics();
        bindControl(document.getElementById("remoteScreenshotToggle")!, 10);
        refreshScreenshots();
        if (screenshots) screenshots.subscribe(refreshScreenshots);
        var footerControls = footer
            ? footer.querySelectorAll("span[data-ott-key]")
            : [];
        // Keep the existing footer shortcuts while making every action reachable
        // by a remote with only directional keys, OK and Back.
        [1, 2, 3, 0].forEach(function (footerIndex, index) {
            if (footerControls[footerIndex])
                bindControl(
                    footerControls[footerIndex] as HTMLElement,
                    index + 4
                );
        });
        selectControl(selectedControl, selectedControl >= 0);
        refreshServerStatus();
        refreshDiscovery();
        var codeInput = document.getElementById(
            "localHttpDeviceCode"
        ) as HTMLInputElement | null;
        if (codeInput) {
            codeInput.onclick = function (event): void {
                event.stopPropagation();
                codeInput!.select();
            };
            codeInput.onkeydown = function (event): void {
                // Let the browser copy the selected code without routing Ctrl+C
                // or arrow keys to the player's remote-control key handler.
                if (
                    event.ctrlKey ||
                    event.metaKey ||
                    /^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)
                )
                    event.stopPropagation();
            };
        }
    }

    function editServer(secret: boolean): void {
        if (discovery) discovery.cancel();
        var draft = beginSettingsDraft();
        $("#listAbout").hide();
        editSettingsText(
            w._(
                secret
                    ? "Server device access code"
                    : "Server address (for example 192.168.1.20:8081)"
            ),
            secret
                ? settings.commandServerToken
                : settings.commandServerAddress,
            function (value): void {
                if (closed || !draft.active()) return;
                if (
                    !draft.set(
                        secret ? "commandServerToken" : "commandServerAddress",
                        value.trim()
                    )
                )
                    return;
                var address = String(
                    draft.get("commandServerAddress") || ""
                ).trim();
                var token = String(
                    draft.get("commandServerToken") || ""
                ).trim();
                // Equivalent edits preserve a deliberate disconnect and an active request.
                try {
                    if (
                        normalizeCommandServerAddress(address) ===
                        normalizeCommandServerAddress(
                            settings.commandServerAddress
                        )
                    )
                        address = settings.commandServerAddress;
                } catch (_error) {}
                if (
                    commandServer &&
                    (address !== settings.commandServerAddress ||
                        token !== settings.commandServerToken)
                )
                    commandServer.configure({
                        address: address,
                        enabled: !!address && !!token,
                        token: token,
                    });
                draft.cancel();
                selectBrowserSourceAfterConnect();
                render();
            },
            function (saved) {
                if (!saved) draft.cancel();
                if (!closed) render();
            },
            secret
        );
    }
    function toggleServer(): void {
        if (discovery) discovery.cancel();
        if (commandServer)
            commandServer.configure({
                address: settings.commandServerAddress,
                enabled: !commandServer.status().enabled,
                token: settings.commandServerToken,
            });
        selectBrowserSourceAfterConnect();
        render();
    }
    function selectBrowserSourceAfterConnect(): void {
        if (!screenshots || w.__ottRemoteInputActive) return;
        var view = screenshots.status();
        if (
            view.connected &&
            view.browserSelectionSupported &&
            view.needsSourceSelection
        )
            screenshots.selectSource(true);
    }
    function toggleHttpRemote(): void {
        if (changingHttpRemote) return;
        var remote = w.__ottLocalHttpRemote;
        if (!remote || typeof remote.setEnabled !== "function") {
            httpRemoteError = true;
            render();
            return;
        }
        changingHttpRemote = true;
        httpRemoteError = false;
        render();
        Promise.resolve()
            .then(function () {
                return remote.setEnabled(!remote.status().enabled);
            })
            .then(
                function () {
                    changingHttpRemote = false;
                    render();
                },
                function () {
                    changingHttpRemote = false;
                    httpRemoteError = true;
                    render();
                }
            );
    }

    function editUrl(swop: boolean): void {
        var title = swop
            ? "Swop base URL (empty disables remote text entry)"
            : "Local command URL (empty disables local command polling)";
        var value = (swop ? w.sSwopBaseUrl : w.sLocalCmdUrl) || "";
        var draft = beginSettingsDraft();
        function save(value: string): boolean {
            if (closed || !draft.active()) return false;
            var normalized = swop
                ? value.trim().replace(/\/+$/, "")
                : value.trim();
            if (!draft.set(swop ? "swopBaseUrl" : "localCmdUrl", normalized))
                return false;
            return draft.commit();
        }
        // listAbout has priority in the key router, so hide it while editing.
        // The editor owns the single-level CPD buffer; our parent is kept locally.
        $("#listAbout").hide();
        editSettingsText(
            title,
            value,
            function (edited) {
                if (save(edited)) render();
            },
            function (saved) {
                if (!saved) draft.cancel();
                if (!closed) render();
            }
        );
    }

    w.aboutKeyHandler = function (e: number): boolean {
        if (e === w.keys.RETURN || e === w.keys.EXIT) {
            close();
            return true;
        }
        if (e === w.keys.LEFT || e === w.keys.RIGHT) {
            var next =
                selectedControl < 0
                    ? e === w.keys.LEFT
                        ? controls.length - 1
                        : 0
                    : (selectedControl +
                          (e === w.keys.LEFT ? -1 : 1) +
                          controls.length) %
                      controls.length;
            for (
                var skip = 0;
                skip < controls.length &&
                (controls[next] as HTMLButtonElement).disabled;
                skip++
            )
                next =
                    (next + (e === w.keys.LEFT ? -1 : 1) + controls.length) %
                    controls.length;
            selectControl(next, true);
            return true;
        }
        if (e === w.keys.ENTER && selectedControl >= 0) {
            controlActions[selectedControl]();
            return true;
        }
        if (e === w.keys.UP || e === w.keys.DOWN) {
            var content = document.getElementById("remoteSettingsContent");
            if (content) {
                var amount = Math.max(40, Math.floor(content.clientHeight / 2));
                content.scrollTop = Math.max(
                    0,
                    content.scrollTop + (e === w.keys.UP ? -amount : amount)
                );
            }
            return true;
        }
        if (e === w.keys.N3 || e === 51 || e === w.keys.N4 || e === 52) {
            selectControl(e === w.keys.N4 || e === 52 ? 1 : 0, false);
            editServer(e === w.keys.N4 || e === 52);
            return true;
        }
        if (e === w.keys.N5 || e === 53) {
            selectControl(2, false);
            toggleServer();
            return true;
        }
        if (e === w.keys.N6 || e === 54) {
            selectControl(3, false);
            if (discovery) discovery.start(true);
            return true;
        }
        if (e === w.keys.ENTER || e === w.keys.N2 || e === 50) {
            selectControl(e === w.keys.ENTER ? 4 : 5, false);
            editUrl(e !== w.keys.ENTER);
            return true;
        }
        if (e === w.keys.N1 || e === 49) {
            selectControl(6, false);
            toggleHttpRemote();
            return true;
        }
        return false;
    };
    render();
};

// Rebuild optionsArr now that all window.* settings functions are defined
optionsArr.length = 0;
var _o = window as any;
optionsArr.push({ action: _o.settingsInterface, name: "Interface settings" });
optionsArr.push({ action: _o.settingsLists, name: "Lists settings" });
optionsArr.push({ action: _o.settingsChannels, name: "Channel list settings" });
optionsArr.push({ action: _o.settingsInfobar, name: "Infobar settings" });
optionsArr.push({ action: _o.settingsButtons, name: "Buttons settings" });
optionsArr.push({ action: _o.settingsMenu, name: "Menu items settings" });
optionsArr.push({ action: _o.parentControlSetup, name: "Parental control" });
optionsArr.push({ action: toggleProviderSelectionVisibility });
optionsArr.push({
    action: showProviderSelection,
    desc: "Change provider - you can change the provider, and it will be remembered at the next start of player!",
    name: "Change provider",
});
// OTTPLAY_FULL_ONLY_BEGIN
optionsArr.push({ action: edit_dealer, name: "Enter Provider Code" });
// OTTPLAY_FULL_ONLY_END
optionsArr.push({ action: _o.settingsManage, name: "Manage settings" });
optionsArr.push({
    action: _o.settingsCommands,
    desc: "Command server address, device access code, local HTTP control, and remote text entry settings",
    name: "Remote control",
});
optionsArr.push({ action: selectLang, name: "Change interface language" });

// Mode B only: Tauri updater check (GitHub Releases latest.json). Mode A untouched.
// Match other @tauri-apps usage: window.__TAURI__ / tauriInvoke — not import().
// Dynamic import hits TS1323 (module:ES2015); static import is stripped by concat
// and cannot resolve bare specifiers in the Mode A/B player.js bundle.
var tauriUpdaterStarted = false;
function checkTauriUpdatesAfterLanguage(): void {
    const standby = window.__ottStandby;
    if (
        typeof window.__TAURI__ === "undefined" ||
        tauriUpdaterStarted ||
        standby?.blocked()
    )
        return;
    tauriUpdaterStarted = true;
    void (async () => {
        const generation = standby?.generation();
        let release = function () {};
        try {
            type UpdaterMeta = {
                rid: number;
                currentVersion: string;
                version: string;
                date?: string;
                body?: string;
            };
            if (standby) release = standby.track(function () {});
            const update = await tauriInvoke<UpdaterMeta | null>(
                "plugin:updater|check",
                { timeout: 10000 }
            );
            release();
            if (!update || (standby && !standby.current(generation))) return;
            const ver = update.version;
            // Soft prompt — do not force install on startup.
            const confirmed = await new Promise<boolean>((resolve) => {
                confirmBox(
                    _(
                        "OttPlay FOSS %1 is available. Download and install now?",
                        ver
                    ),
                    () => resolve(true),
                    () => resolve(false)
                );
            });
            if (confirmed && (!standby || standby.current(generation))) {
                const ChannelCtor = (window as any).__TAURI__?.core?.Channel;
                if (typeof ChannelCtor !== "function") {
                    throw new Error("Tauri Channel unavailable for updater");
                }
                const onEvent = new ChannelCtor();
                if (standby) release = standby.track(function () {});
                await tauriInvoke("plugin:updater|download_and_install", {
                    onEvent,
                    rid: update.rid,
                });
                release();
                if (standby && !standby.current(generation)) return;
                // Relaunch is optional; ask the user to restart if plugin-process is absent.
                try {
                    const processApi = (window as any).__TAURI__?.process;
                    if (processApi?.relaunch) {
                        await processApi.relaunch();
                    } else {
                        infoBox(
                            _("Update installed. Please restart OttPlay FOSS.")
                        );
                    }
                } catch {
                    infoBox(
                        _("Update installed. Please restart OttPlay FOSS.")
                    );
                }
            }
        } catch (err) {
            // Missing latest.json / placeholder pubkey / offline: non-fatal.
            console.debug("Tauri updater check skipped:", err);
        } finally {
            release();
        }
    })();
}
