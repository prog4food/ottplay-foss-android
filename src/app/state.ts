/**
 * Application state for OTT-play FOSS
 * Centralized global state management
 */

// Version
export const PLAYER_VERSION = "__OTTP_VERSION__";

// Host URL
export let hostUrl = "";

// Device type
export let deviceType = "";

// EPG domain
export let epgDomain = "";

// Parental PIN
export let parentPIN = "1234";

// Hide menus list
export let hideMenus: string[] = [];

// Sleep timer
export let sleepTimer: any = null;

// Info timeout
export let infoTimeout: any = null;

// Number input state
export let numberBuffer = "";
export let numberTimeout: any = null;

// List state
export let isListVisible = false;
export let listSelectionIndex = 0;
export let listDataArray: any[] = [];
export let getListItemFn: ((item: any, idx: number) => string) | null = null;
export let detailListActionFn: (() => void) | null = null;
export let selIndex = 0;
export let listArray: any[] = [];

// Edit mode
export let isEditMode = false;
export let editCaption = "";
export let editValue = "";

// Select box
export let isSelectBox = false;

// PiP state
export let pipIndex: number | null = null;
export let pipCatIndex = 0;

// Preview
export let previewChan: any = null;
export let previewTimer: any = null;

// ─── Popup menu — CANONICAL DEFINITION ────────────────────
//
// CONCAT POLICY: this module must stay OFF vite MODULES. Runtime popup
// arrays are allocated in src/index.ts (classic concat). This file is the
// ESM/test source of truth for labels + initPopupActions(); adding it to
// MODULES alongside index's `var popupActions` forks or SyntaxErrors on HS5.
//
// `popupArray` (labels), `popupActions` (handlers) and `popupDetail`
// (per-entry descriptions) are the single source of truth for the popup
// menu and MUST stay index-aligned 1:1.
//
// MUTATION CONTRACT — these must remain the SAME array objects for the
// whole lifetime of the player. `src/provider/index.ts` and all ~47
// `providers/*/provider.js` plugins mutate them in place with `.splice()`,
// `.push()`, `.length = 0` and locate the provider-settings action through
// its stable compatibility identity. Never rebind with `=` — always
// mutate the existing array.

/** Default popup labels. Index-aligned with POPUP_ACTION_NAMES / POPUP_DETAILS. */
export const POPUP_LABELS: string[] = [
    "Toggle Aspect Ratio", // 0
    "Toggle Zoom Mode", // 1
    "Switch sound track", // 2
    "Switch subtitle", // 3
    "Return to previous channel", // 4
    "Pause/Play", // 5
    "Restart stream / Live", // 6
    "Rewind", // 7
    "Call PiP / PiP exchange", // 8
    "Close PiP", // 9
    "Category selection", // 10
    "Show EPG and archive for channel", // 11
    "Show list of channel archive records", // 12
    "Show Media Library", // 13
    "", // 14 — toggleProviderSettingsVisibility (provider insertion point)
    "", // 15 — noop (spacer)
    "Settings", // 16
    "Restart player", // 17
    "Exit player", // 18
    "Information", // 19
];

/**
 * Default per-entry description strings; `null` means "fall back to the
 * label". Index-aligned with POPUP_LABELS: index 7 is "Rewind" and index
 * 12 is "Show list of channel archive records".
 */
export const POPUP_DETAILS: (string | null)[] = [
    null, // 0  Toggle Aspect Ratio
    null, // 1  Toggle Zoom Mode
    null, // 2  Switch sound track
    null, // 3  Switch subtitle
    null, // 4  Return to previous channel
    null, // 5  Pause/Play
    null, // 6  Restart stream / Live
    "Show rewind window", // 7  Rewind
    null, // 8  Call PiP / PiP exchange
    null, // 9  Close PiP
    null, // 10 Category selection
    null, // 11 Show EPG and archive for channel
    "Show list of channel archive records without duplication", // 12
    null, // 13 Show Media Library
    null, // 14
    null, // 15
    null, // 16 Settings
    null, // 17 Restart player
    null, // 18 Exit player
    null, // 19 Information
];

/**
 * Names of the 20 popup handlers, in label order.
 *
 * The handlers themselves live in `src/core`, `src/ui` and `src/provider`,
 * all of which already import from this module — importing them back here
 * would create an import cycle. They are therefore resolved late off
 * `window.*` by `initPopupActions()`, which is the same late-binding
 * pattern `loadProv()` in `src/provider/index.ts` already uses.
 */
export const POPUP_ACTION_NAMES: string[] = [
    "toggleAspectRatio", // 0
    "toggleZoom", // 1
    "toggleAudioTrack", // 2
    "toggleSubtitle", // 3
    "popPrevProg", // 4
    "popPause", // 5
    "popStop", // 6
    "popShift", // 7
    "popTogglePip", // 8
    "popStopPip", // 9
    "popBuckets", // 10
    "popEpg", // 11
    "popRecords", // 12
    "popMedia", // 13
    "toggleProviderSettingsVisibility", // 14
    "noop", // 15
    "optionsList", // 16
    "restart", // 17
    "exitPortal", // 18
    "infoList", // 19
];

// The live arrays. Filled by fillInPlace()/initPopupActions() below —
// never reassigned.
export const popupActions: any[] = [];
export const popupArray: string[] = [];
export const popupDetail: any[] = [];

/** Replace the contents of `target` with `source`, keeping the same object. */
function fillInPlace<T>(target: T[], source: readonly T[]): void {
    target.length = 0;
    for (let i = 0; i < source.length; i++) target.push(source[i]);
}

// Labels and details are plain data, so they can be applied at import time.
// `window.popupArray` / `window.popupDetail` are a supported external
// override for skinned thin clients: if the host page set them, they win
// and the defaults must not clobber them.
fillInPlace(
    popupArray,
    Array.isArray((window as any)?.popupArray)
        ? ((window as any).popupArray as string[])
        : POPUP_LABELS
);
fillInPlace(
    popupDetail,
    Array.isArray((window as any)?.popupDetail)
        ? ((window as any).popupDetail as any[])
        : POPUP_DETAILS
);

/**
 * Populate `popupActions` with the 20 default handlers, resolved late off
 * `window.*` (see POPUP_ACTION_NAMES for why late binding is required).
 *
 * Called from `onStbReady()` in `src/app/init.ts`, after `src/index.ts` has
 * published the handlers on `window`, and before the `savedPopup` snapshot
 * is taken.
 *
 * No-op when `popupActions` is already populated, so a provider plugin that
 * has already spliced its own entries in is never clobbered.
 *
 * @returns true if all 20 handlers resolved to functions.
 */
export function initPopupActions(): boolean {
    if (popupActions.length)
        return popupActions.every((a) => typeof a === "function");
    const w = window as any;
    const resolved = POPUP_ACTION_NAMES.map((name) => w[name]);
    fillInPlace(popupActions, resolved);
    return resolved.every((a) => typeof a === "function");
}

// Saved popup (for provider-switch restoration)
export const savedPopup: {
    ver: string;
    popupActions: any[];
    popupArray: string[];
    popupDetail: any[];
} = { popupActions: [], popupArray: [], popupDetail: [], ver: PLAYER_VERSION };

export const version: string = PLAYER_VERSION;

// Options system (ported from stbPlayer.js)
export const optionsArr: { action: any; name?: string; desc?: string }[] = [];

// Font family list
export const fontFamilyList = [
    "",
    "Roboto, ",
    "RobotoCondensed, ",
    "Caveat, ",
    "Liberation, ",
    "Gabriela, ",
    "PTSansNarrow, ",
];

// Color state — defaults from original stbPlayer.js
export let curColor = "gold";
export let curColorB = "#668";
export let bodyColor = "#f0f0f0";

// Page size
export let pageSize = 25;

// ponytail: setter indirection — callers in other modules must not reassign
// the imported binding directly (illegal in strict ES modules). Route through
// this setter instead.
export function setPageSize(val: number): void {
    pageSize = val;
}
export function setIsListVisible(val: boolean): void {
    isListVisible = val;
}
export function setListSelectionIndex(val: number): void {
    listSelectionIndex = val;
}
export function setListDataArray(val: any[]): void {
    listDataArray = val;
}
export function setGetListItemFn(
    val: ((item: any, idx: number) => string) | null
): void {
    getListItemFn = val;
}
export function setDetailListActionFn(val: (() => void) | null): void {
    detailListActionFn = val;
}

// TMDb
export const TMDb: any = {
    prepare: function () {
        // ponytail: TMDb.prepare is a stub reserved for future use
    },
};

// Performance stamps
export const perfStamps: string[] = [];

// Media check timer
export let mediaCheckTimer: any = null;

// Sleep timer indirection setter — must not reassign exported let from another module
export function setSleepTimer(val: any): void {
    sleepTimer = val;
}

// Backward compat capability detection (was window.client_can)
export const client_can_https = false;
export const client_can = {
    crossxhr:
        typeof navigator !== "undefined" &&
        !/(?:Viera\/1\.)/.test(navigator.userAgent),
    https: client_can_https,
    is_maple:
        typeof navigator !== "undefined" &&
        navigator.userAgent.indexOf("Maple 6") !== -1,
    localstorage: typeof window.localStorage !== "undefined",
    websocket: typeof window.WebSocket !== "undefined",
};
