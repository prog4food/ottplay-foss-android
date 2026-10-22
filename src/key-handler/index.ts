/**
 * Remote control key handler — main dispatch + key function mapping.
 *
 * Ported from player.js keyHandler, keyFun.
 */

import {
    closeFullscreen,
    isNormalScreen,
    openFullscreen,
    stbEventToKeyCode,
    stbToggleTauriNativeFullscreen,
} from "../core";
import { translate as _, formatLocaleNumber } from "../localization";
import { settings } from "../settings";

declare var $: any;

// Virtual keyboard state (from ui/index.ts)
declare var _keysSymbol: { s: string; a: () => void }[];
declare var _keyP: boolean;
declare var _keyE: boolean;
declare var _setLang: (e: boolean) => void;
declare var showEdit: () => void;

/* ---------------------------------------------------------------------------
 * Key codes (from devices/pc/device.js — override per device via window.keys)
 * --------------------------------------------------------------------------- */

export var keys: Record<string, number> = {
    ASPECT: 65,
    AUDIO: 83,
    BLUE: 406,
    CH_DOWN: 189,
    CH_LIST: 0,
    CH_UP: 187,
    DOWN: 40,
    ENTER: 13,
    EPG: 0,
    EXIT: 27,
    FAVORITES: 70,
    FF: 34,
    GREEN: 404,
    INFO: 73,
    LANG: 16,
    LEFT: 37,
    MENU: 179,
    MUTE: 173,
    N0: 48,
    N1: 49,
    N2: 50,
    N3: 51,
    N4: 52,
    N5: 53,
    N6: 54,
    N7: 55,
    N8: 56,
    N9: 57,
    NEXT: 35,
    PAUSE: 19,
    PIP: 87,
    PLAY: 80,
    POWER: 81,
    PRECH: 191,
    PREV: 36,
    REC: 0,
    RED: 403,
    RETURN: 8,
    RIGHT: 39,
    RW: 33,
    SETUP: 192,
    STOP: 83,
    SUBTITLE: 76,
    TOOLS: 84,
    UP: 38,
    VOL_DOWN: 174,
    VOL_UP: 175,
    YELLOW: 405,
    ZOOM: 69,
};

/* ---------------------------------------------------------------------------
 * Mode flags
 * --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Main key dispatch
 * --------------------------------------------------------------------------- */

/** Choose one item from the visible collection without changing its order. */
export function tryKeyboardRandom(event: KeyboardEvent): boolean {
    var w = window as any;
    if (
        !event ||
        !/^pc(?:2)?$/.test(w.ott_device || "") ||
        !(
            event.code === "KeyR" ||
            event.keyCode === 82 ||
            event.which === 82 ||
            event.key === "r" ||
            event.key === "R"
        )
    )
        return false;
    // Keep browser reload shortcuts, native text input, and IME ownership.
    if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
    )
        return true;
    function editable(element: any): boolean {
        while (element) {
            if (
                /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || "") ||
                element.isContentEditable ||
                (element.getAttribute &&
                    element.hasAttribute("contenteditable") &&
                    /^(|true|plaintext-only)$/i.test(
                        element.getAttribute("contenteditable")
                    ))
            )
                return true;
            element = element.parentElement;
        }
        return false;
    }
    if (editable(event.target) || editable(document.activeElement)) return true;
    var kiosk = w.__ottKiosk;
    if (
        kiosk &&
        ((kiosk.strict && kiosk.strict()) || (kiosk.locked && kiosk.locked()))
    )
        return false;
    if (w.__ottStandby?.blocked()) return false;
    var port = w.__ottClassicScreenPort;
    if (!port || !port.screens || typeof port.reconcile !== "function")
        return false;
    port.reconcile();
    var owner = port.screens.current();
    if (owner && owner.kind !== "list") return false;
    var isMedia = !!(
        owner &&
        typeof w.mediaKeyHandler === "function" &&
        (w.listKeyHandlerFn === w.mediaKeyHandler ||
            w.listKeyHandler === w.mediaKeyHandler)
    );
    var isChannels = !!(
        owner &&
        typeof w.channelsKeyHandler === "function" &&
        (w.listKeyHandlerFn === w.channelsKeyHandler ||
            w.listKeyHandler === w.channelsKeyHandler)
    );
    // Custom lists (such as search) own their first press; consume held repeats.
    if (owner && !isMedia && !isChannels && !event.repeat) return false;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (event.repeat) return true;
    if (typeof w.setSleepTimeout === "function") w.setSleepTimeout();
    var media = w.__ottMedia;
    var playing =
        media && typeof media.current === "function" && media.current();
    if (isMedia || (!owner && playing && !playing.sequence?.channel)) {
        if (media && typeof media.randomPlay === "function")
            media.randomPlay(isMedia);
        return true;
    }
    var category = isChannels ? w.listCatIndex : w.catIndex;
    var list = isChannels ? w.listArray : w.curList;
    var label = (w.catsArray || [])[category];
    var categoryList = label === undefined ? null : (w.cats || {})[label];
    if (
        !Array.isArray(list) ||
        !Array.isArray(categoryList) ||
        !list.length ||
        typeof w.playChannel !== "function"
    )
        return true;
    var current = w.curList && w.curList[w.primaryIndex];
    // Keep large local libraries linear; a category can contain thousands of files.
    var members: any = Object.create(null);
    categoryList.forEach(function (id: any, index: number) {
        members[typeof id + ":" + id] = index;
    });
    var choices: number[] = [];
    list.forEach(function (id: any) {
        var index = members[typeof id + ":" + id];
        if (
            index !== undefined &&
            w.channels &&
            w.channels[id] &&
            id !== current
        )
            choices.push(index);
    });
    if (!choices.length) return true;
    var index = choices[Math.floor(Math.random() * choices.length)];
    if (isChannels && typeof w.closeList === "function") w.closeList();
    w.playChannel(category, index);
    return true;
}

/** Own desktop playback arrows before native video controls can seek. */
export function tryKeyboardSeek(event: KeyboardEvent): boolean {
    var w = window as any;
    if (
        !event ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.shiftKey ||
        Number(!!event.altKey) +
            Number(!!event.ctrlKey) +
            Number(!!event.metaKey) >
            1
    )
        return false;
    var direction =
        event.key === "ArrowLeft" || event.code === "ArrowLeft"
            ? -1
            : event.key === "ArrowRight" || event.code === "ArrowRight"
              ? 1
              : event.keyCode === 37
                ? -1
                : event.keyCode === 39
                  ? 1
                  : 0;
    if (!direction) return false;
    var seek = !!(event.altKey || event.ctrlKey || event.metaKey);
    if (!seek && !/^pc(?:2)?$/.test(w.ott_device || "")) return false;
    function editable(element: any): boolean {
        while (element) {
            if (
                /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || "") ||
                element.isContentEditable ||
                (element.getAttribute &&
                    element.hasAttribute("contenteditable") &&
                    /^(|true|plaintext-only)$/i.test(
                        element.getAttribute("contenteditable")
                    ))
            )
                return true;
            element = element.parentElement;
        }
        return false;
    }
    if (editable(event.target) || editable(document.activeElement))
        return false;
    var kiosk = w.__ottKiosk;
    if (
        kiosk &&
        ((typeof kiosk.strict === "function" && kiosk.strict()) ||
            (typeof kiosk.locked === "function" && kiosk.locked()))
    )
        return false;
    var port = w.__ottClassicScreenPort;
    if (!port || !port.screens || typeof port.reconcile !== "function")
        return false;
    port.reconcile();
    if (port.screens.current()) return false;
    var playback = w.__ottClassicPlayback;
    if (
        !playback ||
        typeof playback.snapshot !== "function" ||
        typeof w[seek ? "shiftArchive" : "changeVolume"] !== "function"
    )
        return false;
    var state = playback.snapshot();
    if (
        !state ||
        !state.target ||
        (state.phase !== "playing" && state.phase !== "paused")
    )
        return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (typeof w.setSleepTimeout === "function") w.setSleepTimeout();
    if (seek) w.shiftArchive(direction * 10);
    else w.changeVolume(direction * w.sVolumeStep);
    return true;
}

/** Capture video-focused keys too; the regular bubble handler remains intact. */
export function installKeyboardSeek(): void {
    var w = window as any;
    w.__ottTryKeyboardSeek = tryKeyboardSeek;
    w.__ottTryKeyboardRandom = tryKeyboardRandom;
    if (w.__ottKeyboardSeekCapture || !document.addEventListener) return;
    w.__ottKeyboardSeekCapture = function (event: KeyboardEvent): void {
        if (!tryKeyboardRandom(event)) tryKeyboardSeek(event);
    };
    document.addEventListener("keydown", w.__ottKeyboardSeekCapture, true);
}

/**
 * Main entry point for keyboard and remote-control key events.
 * Routes the event through a priority chain: dialog box → about/list → edit → select box → list → main.
 *
 * @param event - The raw KeyboardEvent from the DOM or a synthetic event.
 * @returns void
 * @sideeffect Calls preventDefault/stopPropagation on the event. Sets `window.isListVisible`. Invokes page-specific handlers.
 * @analysis Falls through modes in order; once a mode handles the key, later modes are skipped. Dialog box always takes priority.
 */
export function keyHandler(event: KeyboardEvent): void {
    cancelNativeListInertia();
    var kiosk = (window as any).__ottKiosk;
    if (kiosk && kiosk.strict && kiosk.strict()) {
        handleTouchCancel();
        kiosk.strictKey(event);
        return;
    }
    if (
        typeof (window as any).__ottTryKeyboardSeek === "function" &&
        (window as any).__ottTryKeyboardSeek(event)
    )
        return;
    if (
        typeof (window as any).__ottTryKeyboardRandom === "function" &&
        (window as any).__ottTryKeyboardRandom(event)
    )
        return;
    // If an input, textarea, or contenteditable is focused, let the browser handle
    // printable typing. But when #listEdit is open (native playlist-name editor),
    // still route accept/cancel so TV Back also reaches handleEditKey → editKey2.
    const target = event.target as HTMLElement | null;
    if (
        target &&
        (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)
    ) {
        try {
            const inputKeyCode = event.keyCode || event.which;
            const cancelKeys = /^(Enter|Escape|GoBack|BrowserBack)$/;
            const isAcceptOrCancel =
                inputKeyCode === 13 ||
                inputKeyCode === 27 ||
                (inputKeyCode &&
                    inputKeyCode !== 8 &&
                    inputKeyCode === keys.RETURN) ||
                cancelKeys.test(event.key) ||
                cancelKeys.test(event.code);
            if (!isAcceptOrCancel || !$("#listEdit").is(":visible")) return;
        } catch (_e) {
            return;
        }
        // Fall through: preventDefault below once keyCode is known.
    }
    var device = (window as any).__ottDevice;
    // A physical keypad with NumLock/Shift can carry a PageUp/Clear legacy
    // code. Honor its explicit digit before a TV adapter remaps that code.
    var keypadDigit =
        /^[0-9]$/.test(event.key) &&
        (/^Numpad[0-9]$/.test(event.code) || event.location === 3);
    var keyCode = keypadDigit
        ? keys["N" + event.key]
        : device
          ? device.eventToKeyCode(event)
          : stbEventToKeyCode(event);
    if (!keyCode) return;
    if (
        (window as any).__ottKiosk &&
        (window as any).__ottKiosk.locked() &&
        keyCode !== keys.VOL_UP &&
        keyCode !== keys.VOL_DOWN &&
        keyCode !== keys.MUTE
    ) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
        if (
            keyCode === keys.STOP &&
            typeof (window as any).__ottKiosk.stopDiagnostics === "function"
        ) {
            if (event.stopImmediatePropagation)
                event.stopImmediatePropagation();
            (window as any).__ottKiosk.stopDiagnostics();
        }
        return;
    }
    // Smart remotes have a combined transport key. Route it through the same
    // PLAY action as separate Play/Pause keys, including page-specific lists.
    if (keyCode === keys.PLAYPAUSE && keys.PLAY) keyCode = keys.PLAY;
    if (typeof (window as any).setSleepTimeout === "function")
        (window as any).setSleepTimeout();

    (window as any).__ottClassicScreenPort.dispatch(
        keyCode,
        event,
        function (command: ScreenCommand) {
            handleMainKey(command.code || 0, event);
        }
    );
}

/* ---------------------------------------------------------------------------
 * Main mode — dispatch by keyCode
 * --------------------------------------------------------------------------- */

/** Toggle live, archive, or VOD using the mode-specific resume path. */
function toggleMainPlayback(): void {
    var w = window as any;
    var playback = w.__ottClassicPlayback;
    var state =
        playback && typeof playback.snapshot === "function"
            ? playback.snapshot()
            : null;
    // Standalone provider/device scripts can still invoke the classic boundary.
    var kind =
        state && state.target
            ? state.target.kind
            : !w.playType
              ? "live"
              : w.playType < 0
                ? "vod"
                : "archive";
    if (kind === "live") {
        if (typeof w.pauseLivePlayback === "function") w.pauseLivePlayback();
        return;
    }
    if (typeof w.stbIsPlaying !== "function") return;
    if (w.stbIsPlaying()) {
        w.forcePlay = false;
        if (typeof w.showShift === "function") w.showShift(_("Pause"));
        if (typeof w.showChannelInfo === "function") w.showChannelInfo(2);
        if (playback && typeof playback.command === "function")
            playback.command({ type: "pause" });
        if (typeof w.stbPause === "function") w.stbPause();
    } else {
        w.forcePlay = true;
        if (typeof w.showShift === "function") w.showShift(_("Play"));
        if (w.$i1 && typeof w.$i1.hide === "function") w.$i1.hide();
        if (kind === "vod" || w.fileArchive) {
            if (playback && typeof playback.command === "function")
                playback.command({ type: "resume" });
            if (typeof w.stbContinue === "function") w.stbContinue();
        } else if (typeof w.playArchive === "function") {
            var epoch =
                state && state.target ? state.target.archiveStart : w.playType;
            var position =
                state && state.target ? state.position : w.playTime || 0;
            w.playArchive(epoch + position - (w.s10resum ? 10 : 0));
        }
    }
}

/**
 * Handle a key event in "main" mode — the default mode when no dialog/list/edit/select-box is active.
 * Maps key codes to actions: number input, navigation, playback control, volume, color keys, etc.
 *
 * @param keyCode - The numeric key code captured from the event.
 * @param event - The original KeyboardEvent (preventDefault/stopPropagation already called).
 * @returns void
 * @sideeffect Calls any of the following on `window`: numberProg, keyFun, channelsList, infoBarHide, exitPortal,
 *             popupList, prevProg, stbPause/stbContinue, playChannel, stbToggleMute, stbSetVolume,
 *             showShift, showChannelInfo, epgList, togglePip, stbStop/stbStopPip, stbExit, etc.
 *             Sets `window.isListVisible` for CH_LIST and SETUP.
 * @analysis Digits 0-9 are handled before the switch. Color keys are skipped when settings.noColorKeys is set.
 *             RETURN dispatches based on settings.eFun (0-4). The PLAY/PAUSE toggle uses stbIsPlaying().
 */
function handleMainKey(keyCode: number, event: KeyboardEvent): void {
    var w = window as any;
    var command: ScreenCommand = w.__ottClassicScreenPort.normalize(
        keyCode,
        event
    );
    event.preventDefault();
    event.stopPropagation();
    function call(name: string, ...args: any[]) {
        if (typeof w[name] === "function") return w[name].apply(w, args);
    }
    function currentChannel() {
        call("playChannel", w.catIndex, w.primaryIndex);
    }
    function live() {
        call("showShift", _(w.playType ? "Live" : "Restart stream"));
        currentChannel();
    }
    function guide() {
        call("epgList", w.catIndex, w.primaryIndex, false);
    }
    var digit = /^digit-([0-9])$/.exec(command.id);
    if (digit) {
        var value = Number(digit[1]);
        if (w.playType) {
            var seeks: any = {
                1: -w.s13dur,
                3: w.s13dur,
                4: -w.s46dur,
                6: w.s46dur,
                7: -w.s79dur,
                9: w.s79dur,
            };
            if (seeks[value] !== undefined) call("shiftArchive", seeks[value]);
            else if (value === 2 || value === 5)
                call("keyFun", value === 2 ? 20 : 21);
            else if (value === 8) live();
            else if (value === 0) toggleMainPlayback();
        } else if (value === 0 && w.nProg === "") call("liveStop");
        else call("numberProg", value);
        return;
    }
    if (w.playType < 0 && /^(up|down|left|right)$/.test(command.id)) {
        var media = w.__ottMedia && w.__ottMedia.current();
        // A remote Plex queue keeps the selected TV provider unchanged.
        if (
            media &&
            (/^plex(?:@|$)/.test(media.ref.sourceId) ||
                (media.sequence && media.sequence.channel))
        ) {
            if (command.id === "left" || command.id === "right")
                call("shiftArchive", command.id === "left" ? -10 : 10);
            else w.__ottMedia.skip(command.id === "up" ? 1 : -1);
            return;
        }
    }
    var configured: any = {
        blue: "bFun",
        down: "adFun",
        forward: "ffFun",
        green: "gFun",
        left: "alFun",
        next: "nextFun",
        previous: "prevFun",
        red: "rFun",
        rewind: "rewFun",
        right: "arFun",
        up: "auFun",
        yellow: "yFun",
    };
    if (configured[command.id]) {
        if (
            !settings.noColorKeys ||
            !/^(red|green|yellow|blue)$/.test(command.id)
        )
            keyFun((settings as any)[configured[command.id]]);
        return;
    }
    var actions: { [id: string]: () => void } = {
        accept: function () {
            if (w.playType && w.forcePlay === false) toggleMainPlayback();
            else if (w.playType === -1e11) call("mediaList", null);
            else if (w.playType > 0 && !settings.okFun) guide();
            else actions.channels();
        },
        aspect: function () {
            call("stbToggleAspectRatio");
        },
        audio: function () {
            call("stbToggleAudioTrack");
        },
        back: function () {
            if (w.$i1 && w.$i1.is(":visible")) {
                call("infoBarHide");
                return;
            }
            var exits = ["", "exitPortal", "joyMenu", "popupList", "prevProg"];
            if (exits[settings.eFun]) call(exits[settings.eFun]);
        },
        "channel-down": function () {
            call("minusProg");
        },
        "channel-up": function () {
            call("plusProg");
        },
        channels: function () {
            call("channelsList", w.catIndex, w.primaryIndex);
        },
        exit: function () {
            call("exitPortal");
        },
        guide: function () {
            if (w.playType > -1) guide();
        },
        info: function () {
            call("showChannelInfo", settings.infoTimeout);
        },
        language: function () {
            if (!_keysSymbol[1].s) return;
            _keyP = false;
            _setLang(!_keyE);
            showEdit();
        },
        menu: function () {
            call("popupList");
        },
        mute: function () {
            call("stbToggleMute");
        },
        pause: toggleMainPlayback,
        "picture-in-picture": function () {
            call("togglePip");
        },
        play: toggleMainPlayback,
        power: function () {
            try {
                call("body_onUnload");
            } catch (_) {
                // Persistence must not prevent the user's explicit exit.
            }
            // Exit preserves the next launch's playback intent. A denied or
            // asynchronous window close must not become persistent standby.
            ["stbStop", "stbStopPip"].forEach(function (name) {
                try {
                    call(name);
                } catch (_) {
                    // Retire the other lane and exit even if cleanup fails.
                }
            });
            call("stbExit");
        },
        "previous-channel": function () {
            call("prevProg");
        },
        settings: function () {
            call("optionsList");
        },
        stop: live,
        subtitle: function () {
            if (typeof w.__TAURI__ !== "undefined")
                void stbToggleTauriNativeFullscreen();
            else if (isNormalScreen()) openFullscreen();
            else closeFullscreen();
        },
        tools: function () {
            call("popupList");
        },
        "volume-down": function () {
            volume(-1);
        },
        "volume-up": function () {
            volume(1);
        },
        zoom: function () {
            call("stbToggleZoom");
        },
    };
    function volume(direction: number) {
        var current =
            typeof w.stbGetVolume === "function" ? w.stbGetVolume() : 50;
        var value = Math.max(
            0,
            Math.min(100, current + direction * settings.volumeStep)
        );
        call("stbSetVolume", value);
        call("showShift", _("volume") + ": " + formatLocaleNumber(value));
    }
    if (actions[command.id]) actions[command.id]();
}

/* ---------------------------------------------------------------------------
 * Programmatic key dispatch
 * --------------------------------------------------------------------------- */

/**
 * Programmatic key dispatch — fires a synthetic key event through the normal keyHandler pipeline.
 * Useful for calling from non-keyboard sources (clicks, touch, timers).
 *
 * @param keyCode - The numeric key code to dispatch.
 * @param event - Optional original Event (its stopPropagation is called if provided).
 * @returns void
 * @sideeffect Invokes the same handler chain as a real KeyboardEvent.
 * @analysis Creates a minimal fake event object with preventDefault/stopPropagation no-ops.
 */
export function dispatchKey(keyCode: number, event?: Event): void {
    var standby = (window as any).__ottStandby;
    if (standby && standby.localKey && standby.localKey(event)) return;
    if (event) event.stopPropagation();
    keyHandler({
        keyCode: keyCode,
        preventDefault: () => {},
        stopPropagation: () => {},
    } as any);
}

/* ---------------------------------------------------------------------------
 * Key function mapping (keyFun) — maps function number to action
 * --------------------------------------------------------------------------- */

/**
 * Map a function number (0-21) to a specific action and execute it.
 * Used by the configurable button bindings in settings (e.g. settings.rFun, settings.gFun, etc.).
 *
 * @param fn - The function index (0 through 21).
 * @returns void
 * @sideeffect Dispatches to: recordsList, popupList, prevProg, shiftArchiveSelect, showChannelInfo,
 *             toggleAspectRatio, toggleAudioTrack, togglePip, stbStopPip, bucketsList, epgList,
 *             popMedia, joyMenu, changeVolume, shiftArchive, plusProg/minusProg, toggleSubtitle,
 *             playArchive, playChannel, showShift, timeShift.
 * @analysis Functions 15/16/19/20/21 branch on playType to choose between shift-archive and live-channel actions.
 *             Function 20 handles the "restart current program" use case with boundary checking against epgArray.
 */
export function keyFun(fn: number): void {
    var w = window as any;
    var id = w.__ottInputRouter.binding(fn);
    // Local videos are finite media, but these bindings still change files.
    var localVideos = w.__ottActiveProviderDriver?.id === "offline";
    function call(name: string, ...args: any[]) {
        if (typeof w[name] === "function") return w[name].apply(w, args);
    }
    var actions: { [id: string]: () => void } = {
        "archive.minute-back": function () {
            call("shiftArchive", -60);
        },
        "archive.minute-forward": function () {
            if (w.playType) call("shiftArchive", 60);
            else call("shiftArchiveSelect", -60);
        },
        "archive.records": function () {
            if (w.playType > -1)
                call("recordsList", w.catIndex, w.primaryIndex, false);
        },
        "archive.seek": function () {
            call("shiftArchiveSelect", 0);
        },
        "audio.track": function () {
            call("toggleAudioTrack");
        },
        "channel.previous": function () {
            call("prevProg");
        },
        "channels.categories": function () {
            call("bucketsList", w.catIndex);
        },
        "guide.open": function () {
            if (w.playType > -1)
                call("epgList", w.catIndex, w.primaryIndex, false);
        },
        "information.channel": function () {
            call("showChannelInfo");
        },
        "media.open": function () {
            call("popMedia");
        },
        "menu.open": function () {
            call("popupList");
        },
        "navigation.backward": function () {
            if (w.playType && !localVideos) call("shiftArchiveSelect", 0);
            else call("minusProg");
        },
        "navigation.forward": function () {
            if (w.playType && !localVideos) call("shiftArchiveSelect", 60);
            else call("plusProg");
        },
        "navigation.quick": function () {
            call("joyMenu");
        },
        "pip.close": function () {
            w.pipIndex = null;
            call("stbStopPip");
        },
        "pip.toggle": function () {
            call("togglePip");
        },
        "program.next": function () {
            if (w.playType < 0) return;
            if (!w.playType) {
                call("shiftArchiveSelect", -60);
                return;
            }
            var next = w.epgArray[w.curProg + 1];
            if (next && next.time < Date.now() / 1e3)
                call("playArchive", next.time);
            else {
                call("showShift", _("Live"));
                call("playChannel", w.catIndex, w.primaryIndex);
            }
        },
        "program.previous": function () {
            if (w.playType < 0) {
                call("shiftArchive", -6e6);
                return;
            }
            if (!w.playType) {
                call("timeShift", 0);
                return;
            }
            var current = w.epgArray[w.curProg];
            var target =
                w.playType + w.playTime - current.time > 30
                    ? current
                    : w.epgArray[w.curProg - 1];
            if (target) call("playArchive", target.time);
        },
        "subtitle.track": function () {
            call("toggleSubtitle");
        },
        "video.aspect": function () {
            call("toggleAspectRatio");
        },
        "volume.decrease": function () {
            call("changeVolume", -w.sVolumeStep);
        },
        "volume.increase": function () {
            call("changeVolume", w.sVolumeStep);
        },
    };
    if (id && actions[id]) actions[id]();
}

// Touch handlers
var xDown: number | null = null,
    yDown: number | null = null,
    xUp: number | null = null,
    yUp: number | null = null,
    touch_locked = false;
var xMove1: number | null = null,
    yMove1: number | null = null,
    tCount: number | undefined;
var touchMaxDistance = 0;
var touch_min_sensY = Math.round(screen.height / 10);
var touch_min_sensX = Math.round(
    touch_min_sensY * (screen.width / screen.height) * 2
);
var nativeListTouch: {
    target: HTMLElement;
    owner: any;
    rows: any[];
    startX: number;
    startY: number;
    referenceY: number;
    rowHeight: number;
    axis: "" | "vertical" | "horizontal";
    moved: boolean;
    cancelled: boolean;
    samples: number[][];
    velocity: number;
} | null = null;
var nativeListInertia: { release: () => void } | null = null;
var nativeListFrame = 0;

// Native list gestures use row distances; other shells retain remote gestures.
function capacitorOnly(): boolean {
    return typeof (window as any).Capacitor !== "undefined";
}

// Tap detection
/**
 * Detect whether a touch interaction qualifies as a "tap" (stationary press) rather than a swipe.
 * Compares start and end coordinates; if both X and Y deltas are below a sensitivity threshold, it is a tap.
 *
 * @param e - Start X (screenX at touchstart).
 * @param t - Start Y (screenY at touchstart).
 * @param r - End X (screenX at touchend).
 * @param s - End Y (screenY at touchend).
 * @param n - X-axis sensitivity threshold.
 * @param i - Y-axis sensitivity threshold (unused in body; the X threshold is used for both axes).
 * @returns boolean — true if the movement is within the tap threshold.
 * @analysis The body defaults to using `touch_min_sensX / 2` for X and `touch_min_sensY / 2` for Y.
 *             Note: parameter `i` is declared but currently unused in the body of this function.
 */
export function checkTap(
    e: number,
    t: number,
    r: number,
    s: number,
    n: number,
    i: number
): boolean {
    if (
        Math.abs(e - r) < touch_min_sensX / 10 &&
        Math.abs(t - s) < touch_min_sensX / 10
    )
        return true;
    return false;
}

// Swipe direction: bitmask 1=left, 2=down, 4=right, 8=up
/**
 * Determine the direction of a swipe gesture as a bitmask.
 * Bits: 1=left, 2=down, 4=right, 8=up. Multiple bits can be set for diagonal swipes.
 *
 * @param e - Start X (screenX at touchstart).
 * @param t - Start Y (screenY at touchstart).
 * @param r - End X (screenX at touchend / touchmove).
 * @param s - End Y (screenY at touchend / touchmove).
 * @param n - X-axis minimum distance threshold to register a horizontal swipe.
 * @param i - Y-axis minimum distance threshold to register a vertical swipe.
 * @returns number — Bitmask (1=left, 2=down, 4=right, 8=up). Returns 0 if no direction meets the threshold.
 * @analysis This does not normalize for diagonal — both horizontal and vertical bits can be set simultaneously.
 */
export function getDirection(
    e: number,
    t: number,
    r: number,
    s: number,
    n: number,
    i: number
): number {
    var a = 0;
    if (r - e > n) a |= 4;
    else if (e - r > n) a |= 1;
    if (s - t > i) a |= 2;
    else if (t - s > i) a |= 8;
    return a;
}

// Number input state
var nProg = "";
var numTimeout: any = null;
var numProgEl: HTMLElement | null = null;

/**
 * Handle incremental numeric channel/program input (digit-by-digit, like a remote control).
 * Accumulates digits into `nProg`, shows the partial number and channel name, then after a 2-second
 * timeout switches to the selected channel.
 *
 * @param digit - The digit (0-9) pressed.
 * @returns void
 * @sideeffect Mutates the `channelNumberElement` DOM node (shows/hides it, sets innerHTML).
 *             Uses setTimeout to delay channel switch; clears previous timeout on each new digit.
 *             Special sequences: "9999" + 7 toggles info visibility; "9999" + 9 opens popup menu.
 * @analysis Max 4 digits accumulated. Leading zero is rejected (empty string + 0 returns early).
 *             The parsed index (nProg - 1) is checked against curList bounds before calling playChannel.
 *             Timeout of 2000ms resets the input if no further digit arrives.
 */
export function numberProg(digit: number): void {
    if (nProg === "" && !digit) return;
    if (nProg.length === 4) {
        if (nProg === "9999") {
            if (digit === 7) {
                var info = document.getElementById("info");
                if (info)
                    info.style.display =
                        info.style.display === "none" ? "" : "none";
            }
            if (digit === 9 && typeof (window as any).popupList === "function")
                (window as any).popupList();
        }
        return;
    }
    nProg += digit.toString();
    var idx = Number.parseInt(nProg, 10) - 1;
    if (!numProgEl) numProgEl = document.getElementById("numprog");
    if (numProgEl) {
        numProgEl.innerHTML =
            nProg +
            (idx < 0 ||
            idx >=
                ((window as any).curList ? (window as any).curList.length : 0)
                ? ""
                : "<br/>" +
                  ((window as any).channels &&
                  (window as any).curList &&
                  (window as any).channels[(window as any).curList[idx]]
                      ? (window as any).channels[(window as any).curList[idx]]
                            .channel_name
                      : ""));
        numProgEl.style.display = "";
    }
    clearTimeout(numTimeout);
    numTimeout = setTimeout(() => {
        if (numProgEl) numProgEl.style.display = "none";
        var e = Number.parseInt(nProg) - 1;
        nProg = "";
        if (
            e < 0 ||
            e >=
                ((window as any).curList
                    ? (window as any).curList.length
                    : 0) ||
            e === (window as any).primaryIndex
        )
            return;
        if (typeof (window as any).playChannel === "function")
            (window as any).playChannel((window as any).catIndex, e);
    }, 2000);
}

/**
 * Move to the next channel/program in the current list (wraps around to the first).
 *
 * @returns void
 * @sideeffect Calls `window.playChannel(catIndex, primaryIndex + 1)` with wrap-around.
 * @analysis If primaryIndex is undefined/falsy, defaults to 0. If the incremented index exceeds the list,
 *             wraps to 0. Uses curList.length as the upper bound.
 */
export function plusProg(): void {
    var e = ((window as any).primaryIndex || 0) + 1;
    var len = (window as any).curList ? (window as any).curList.length : 0;
    if (e >= len) e = 0;
    if (typeof (window as any).playChannel === "function")
        (window as any).playChannel((window as any).catIndex, e);
}

/**
 * Move to the previous channel/program in the current list (wraps around to the last).
 *
 * @returns void
 * @sideeffect Calls `window.playChannel(catIndex, primaryIndex - 1)` with wrap-around.
 * @analysis If primaryIndex is undefined/falsy, defaults to 0. If decremented below 0, wraps to len - 1.
 */
export function minusProg(): void {
    var e = ((window as any).primaryIndex || 0) - 1;
    var len = (window as any).curList ? (window as any).curList.length : 0;
    if (e < 0) e = len - 1;
    if (typeof (window as any).playChannel === "function")
        (window as any).playChannel((window as any).catIndex, e);
}

/**
 * Callback invoked when the user selects an entry from the "previous programs" list.
 * Restores the channel and either plays the archived timeshift position or tunes live.
 *
 * @param sel - Selected index into the `prevArr` array.
 * @returns void
 * @sideeffect Calls `window.setCurrent`, `window.getChannelEpgCached`, `window.publishChannelProgrammeRows`,
 *             `window.playArchive`, or `window.playChannel`.
 * @analysis Binds the selected identity before PIN/EPG callbacks and resolves its current list position.
 *             Authorization and async ownership are checked before playback; removed categories are harmless.
 */
function onPrevSelect(sel: number): void {
    var w = window as any;
    var entry = Array.isArray(w.prevArr) ? w.prevArr[sel] : null;
    if (!entry || typeof entry !== "object") return;
    // Capture identity and timestamp before selection/PIN can rewrite the journal.
    var chId = entry.ci;
    var category = entry.c;
    var groupId = entry.groupId;
    var timestamp = entry.t;
    var archive = timestamp !== undefined;
    if (
        !(
            (typeof chId === "number" && isFinite(chId)) ||
            (typeof chId === "string" && chId.trim().length > 0)
        )
    )
        return;
    if (
        archive &&
        (typeof timestamp !== "number" ||
            !isFinite(timestamp) ||
            timestamp <= 0)
    )
        return;
    var catalog = w.channels;
    var channel = catalog && catalog[chId];
    var playback = w.__ottClassicPlayback;
    if (
        !channel ||
        !playback ||
        typeof playback.guard !== "function" ||
        typeof w.ifParentalAccessChId !== "function"
    )
        return;

    function locate(): { category: number; index: number } | null {
        var names = w.catsArray;
        var lists = w.cats;
        if (
            !Array.isArray(names) ||
            !lists ||
            w.channels !== catalog ||
            catalog[chId] !== channel
        )
            return null;
        // Resolve stable identity at every admission boundary, including after PIN.
        // A removed group may use All, never the unrelated group now at old c.
        var preferred =
            typeof groupId === "string"
                ? w.__ottChannels?.index(groupId)
                : category;
        if (typeof groupId === "string" && !(preferred >= 0))
            preferred = names.indexOf(groupId);
        var order = [preferred, names.indexOf(_("All"))];
        for (var i = 0; i < names.length; i++) order.push(i);
        for (var at = 0; at < order.length; at++) {
            var candidate = order[at];
            if (
                typeof candidate !== "number" ||
                candidate < 0 ||
                candidate % 1 ||
                candidate >= names.length
            )
                continue;
            var list = lists[names[candidate]];
            if (!Array.isArray(list)) continue;
            var index = list.indexOf(chId);
            if (index !== -1) return { category: candidate, index: index };
        }
        return null;
    }

    function authorize(action: () => void): void {
        if (!locate()) return;
        var proceed = playback.guard(function (): void {
            if (locate()) action();
        });
        if (!w.ifParentalAccessChId(chId, proceed)) proceed();
    }

    if (!locate()) return;
    authorize(function (): void {
        var selection = locate();
        if (!selection) return;
        if (!archive) {
            if (typeof w.playChannel === "function")
                w.playChannel(selection.category, selection.index);
            return;
        }
        if (
            typeof w.setCurrent !== "function" ||
            typeof w.getChannelEpgCached !== "function" ||
            typeof w.playArchive !== "function"
        )
            return;
        w.setCurrent(selection.category, selection.index, true);
        var complete = playback.guard(function (_id: any, epgData: any): void {
            // Access may expire while EPG is loading; no archive effect precedes this gate.
            authorize(function (): void {
                var recent: any[] = [];
                var cutoff =
                    Date.now() / 1e3 - (Number(channel.rec) || 0) * 3600;
                if (Array.isArray(epgData)) {
                    for (var i = 0; i < epgData.length; i++) {
                        if (epgData[i] && epgData[i].time > cutoff)
                            recent.push(epgData[i]);
                    }
                    recent.sort((a: any, b: any) => a.time - b.time);
                }
                w.epgArray = recent;
                if (typeof w.publishChannelProgrammeRows === "function")
                    w.publishChannelProgrammeRows(chId, epgData, null);
                w.playArchive(timestamp);
            });
        });
        w.getChannelEpgCached(chId, complete);
    });
}

/**
 * Show the "previous programs" list and navigate to the selected channel/timeshift.
 * With 0 entries: does nothing. With 1 entry: restores its live/archive target through the guarded selection path.
 * With 2+ entries: opens a select-box listing each entry with channel name, timestamp (if archived), and event name.
 *
 * @returns void
 * @sideeffect Calls `window.playChannel`, `window.showSelectBox`, or renders a popup list.
 *             Nested helpers `timeToday` and `fmtTime` format archived positions.
 * @analysis Entries with invalid data are spliced out of the array during iteration. Archived entries
 *             show a red timestamp; live entries show no timestamp. Falls back to category "All" if the
 *             original category lookup fails.
 */
export function prevProg(): void {
    var prevArr = (window as any).prevArr || [];
    /**
     * Check whether a Unix timestamp falls within today (00:00:00 to 23:59:59 local time).
     *
     * @param e - Unix timestamp in seconds.
     * @returns boolean — true if the timestamp is within the current calendar day.
     */
    function timeToday(e: number): boolean {
        var t =
            Math.floor(Date.now() / 864e5) * 86400 +
            new Date().getTimezoneOffset() * 60;
        return e >= t && e < t + 86400;
    }
    /**
     * Format a Unix timestamp for display. If it falls within today, uses time2time (HH:MM).
     * Otherwise uses formatProgramDateTime (day + date + time).
     *
     * @param e - Unix timestamp in seconds.
     * @returns string — Formatted time string, or empty string if neither helper is available.
     */
    function fmtTime(e: number): string {
        return timeToday(e)
            ? (window as any).time2time(e)
            : (window as any).formatProgramDateTime
              ? (window as any).formatProgramDateTime(e)
              : "";
    }
    switch (prevArr.length) {
        case 0:
            return;
        case 1:
            onPrevSelect(0);
            return;
        default: {
            var items: string[] = [];
            prevArr.forEach((entry: any, idx: number, arr: any[]) => {
                try {
                    items.push(
                        ((window as any).channels &&
                        (window as any).channels[entry.ci]
                            ? (window as any).channels[entry.ci].channel_name
                            : "") +
                            (entry.t
                                ? '<span style="color:red;"> - ' +
                                  fmtTime(entry.t) +
                                  "</span>"
                                : "") +
                            (entry.e
                                ? ' <span style="color:#f9bf3b;"><span style="color:#607d8b;">&#x02237; </span>' +
                                  entry.e +
                                  "</span>"
                                : "")
                    );
                } catch (e) {
                    arr.splice(idx, 1);
                }
            });
            if (typeof (window as any).showSelectBox === "function") {
                (window as any).showSelectBox(0, items, onPrevSelect, 0);
            }
        }
    }
}

/**
 * Handle the `touchstart` event on the document body.
 * Records starting touch coordinates and detects 4-finger touch to toggle touch lock.
 *
 * @param e - The TouchEvent object (typed as `any` for compatibility).
 * @returns void
 * @sideeffect Calls `e.preventDefault()`. Sets module-level variables `xDown`, `yDown`, `xUp`, `yUp`,
 *             `xMove1`, `yMove1`, `tCount`, `touch_locked`. Shows an `alert()` when locking/unlocking.
 * @analysis 4-finger touch toggles `touch_locked` flag. When locked, all subsequent touch events are ignored.
 *             The initial move reference (`xMove1`/`yMove1`) is set equal to the start coordinates.
 */
function isNativeTouchEditor(target: any): boolean {
    if (!capacitorOnly()) return false;
    for (var el = target; el; el = el.parentElement) {
        if (
            /^(INPUT|TEXTAREA|SELECT|OPTION|LABEL)$/.test(el.tagName || "") ||
            el.isContentEditable
        )
            return true;
    }
    return false;
}

function resetNativeListTouch(): void {
    if (!nativeListTouch) return;
    var target = nativeListTouch.target;
    target.removeEventListener("touchmove", forwardNativeListTouch);
    target.removeEventListener("touchend", forwardNativeListTouch);
    target.removeEventListener("touchcancel", forwardNativeListTouch);
    nativeListTouch = null;
}

function cancelNativeListInertia(): void {
    var coast = nativeListInertia;
    if (!coast) return;
    nativeListInertia = null;
    if (nativeListFrame) cancelAnimationFrame(nativeListFrame);
    nativeListFrame = 0;
    if (coast) coast.release();
}

function startNativeListInertia(): void {
    var gesture = nativeListTouch;
    if (!gesture || gesture.cancelled || gesture.axis !== "vertical") return;
    var start = performance.now();
    if (
        start - gesture.samples[gesture.samples.length - 1][1] > 120 ||
        Math.abs(gesture.velocity) < 0.01
    )
        return;
    cancelNativeListInertia();
    var w = window as any;
    var limit = (w.listPageSize || 25) / 80;
    var velocity = Math.max(-limit, Math.min(limit, gesture.velocity));
    var initial = w.selIndex;
    var expected = initial;
    var previous = start;
    var coast = { release: function () {} };
    nativeListInertia = coast;
    coast.release = gesture.owner.own(function () {
        if (nativeListInertia === coast) cancelNativeListInertia();
    });
    function frame(): void {
        if (nativeListInertia !== coast) return;
        var now = performance.now();
        var rows = w.listDataArray?.length ? w.listDataArray : w.listArray;
        if (
            !gesture!.owner.foreground() ||
            !w.isListVisible ||
            document.hidden ||
            rows !== gesture!.rows ||
            w.selIndex !== expected ||
            now < previous ||
            now - previous > 160
        ) {
            cancelNativeListInertia();
            return;
        }
        previous = now;
        var elapsed = now - start;
        var decay = Math.exp(-elapsed / 500);
        var distance = velocity * 500 * (1 - decay);
        var steps = distance < 0 ? Math.ceil(distance) : Math.floor(distance);
        var next = Math.max(0, Math.min(rows.length - 1, initial + steps));
        // Skip straight to the destination page: never render each crossed row.
        if (next !== expected) w.changeSelect(next - expected);
        if (nativeListInertia !== coast) return;
        expected = next;
        if (
            elapsed >= 1400 ||
            Math.abs(velocity * decay) < 0.002 ||
            (velocity < 0 ? next === 0 : next === rows.length - 1)
        )
            cancelNativeListInertia();
        else nativeListFrame = requestAnimationFrame(frame);
    }
    nativeListFrame = requestAnimationFrame(frame);
}

function forwardNativeListTouch(e: TouchEvent): void {
    // Paging replaces the starting row. Its remaining touch events still target
    // that detached node, so a body listener alone loses the rest of the gesture.
    e.stopPropagation();
    if (e.type === "touchmove") handleTouchMove(e);
    else if (e.type === "touchend") body_handleTouchEnd(e);
    else handleTouchCancel();
}

function startNativeListTouch(e: any): void {
    if (!capacitorOnly() || tCount !== 1) return;
    var w = window as any;
    var target = e.target as HTMLElement;
    var list = document.getElementById("listIn");
    var owner = w.__ottClassicScreenPort?.listOwner();
    var rows = w.listDataArray?.length ? w.listDataArray : w.listArray;
    var height = Number(w.__ottListRowH);
    if (
        !target ||
        !list?.contains(target) ||
        !w.isListVisible ||
        !owner?.foreground() ||
        !rows?.length ||
        !(height > 0) ||
        !isFinite(height)
    )
        return;
    var touch = e.touches[0];
    nativeListTouch = {
        axis: "",
        cancelled: false,
        moved: false,
        owner: owner,
        referenceY: touch.clientY,
        rowHeight: height,
        rows: rows,
        samples: [[touch.clientY, performance.now()]],
        startX: touch.clientX,
        startY: touch.clientY,
        target: target,
        velocity: 0,
    };
    target.addEventListener("touchmove", forwardNativeListTouch, {
        passive: false,
    });
    target.addEventListener("touchend", forwardNativeListTouch, {
        passive: false,
    });
    target.addEventListener("touchcancel", forwardNativeListTouch, {
        passive: false,
    });
}

function moveNativeListTouch(touch: any): boolean {
    var gesture = nativeListTouch;
    if (!gesture) return false;
    var w = window as any;
    var rows = w.listDataArray?.length ? w.listDataArray : w.listArray;
    if (
        gesture.cancelled ||
        !gesture.owner.foreground() ||
        !w.isListVisible ||
        rows !== gesture.rows
    ) {
        gesture.cancelled = gesture.moved = true;
        return true;
    }
    if (!touch) return true;
    if (!isFinite(touch.clientX) || !isFinite(touch.clientY)) {
        gesture.cancelled = gesture.moved = true;
        return true;
    }
    var dx = touch.clientX - gesture.startX;
    var dy = touch.clientY - gesture.startY;
    if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) {
        gesture.moved = true;
        gesture.axis = Math.abs(dy) >= Math.abs(dx) ? "vertical" : "horizontal";
    }
    if (gesture.axis === "horizontal") return false;
    if (gesture.axis !== "vertical") return true;
    var now = performance.now();
    var samples = gesture.samples;
    var last = samples[samples.length - 1];
    var movement = last[0] - touch.clientY;
    if (now < last[1] || now - last[1] > 120) {
        gesture.samples = [[touch.clientY, now]];
        gesture.velocity = 0;
    } else if (movement && now > last[1]) {
        // Only recent motion contributes; reversal must discard old momentum.
        if (gesture.velocity * movement < 0) samples = gesture.samples = [last];
        samples.push([touch.clientY, now]);
        while (
            samples.length > 2 &&
            (now - samples[1][1] > 100 || samples.length > 16)
        )
            samples.shift();
        gesture.velocity =
            (samples[0][0] - touch.clientY) /
            (now - samples[0][1]) /
            gesture.rowHeight;
    }
    var distance = (gesture.referenceY - touch.clientY) / gesture.rowHeight;
    var steps = distance < 0 ? Math.ceil(distance) : Math.floor(distance);
    if (!steps) return true;
    var current = w.selIndex;
    var next = Math.max(0, Math.min(rows.length - 1, current + steps));
    gesture.referenceY -= steps * gesture.rowHeight;
    // Discard overscroll so reversing at either end responds immediately.
    if (next !== current + steps) gesture.referenceY = touch.clientY;
    if (next !== current) w.changeSelect(next - current);
    return true;
}

function updateTouchPosition(touch: any): void {
    if (!touch) return;
    xUp = Math.round(touch.screenX);
    yUp = Math.round(touch.screenY);
    if (tCount === 1)
        touchMaxDistance = Math.max(
            touchMaxDistance,
            Math.abs(xUp - xDown!),
            Math.abs(yUp - yDown!)
        );
}

function handleTouchCancel(): void {
    cancelNativeListInertia();
    resetNativeListTouch();
    xDown = yDown = xUp = yUp = xMove1 = yMove1 = null;
    tCount = undefined;
    touchMaxDistance = 0;
}

function handleTouchStart(e: any): void {
    if (
        nativeListTouch &&
        e.touches.length > 1 &&
        (nativeListTouch.moved || !nativeListTouch.target.isConnected)
    ) {
        // Adding a finger after paging cancels the swipe. Keep its original
        // target subscribed until the last finger lifts, in either lift order.
        e.preventDefault();
        nativeListTouch.cancelled = nativeListTouch.moved = true;
        return;
    }
    handleTouchCancel();
    // Let the WebView focus editors, open its keyboard and handle native controls.
    // Synthesized clicks cannot replace those trusted touch default actions.
    if (
        !touch_locked &&
        e.touches.length !== 4 &&
        isNativeTouchEditor(e.target)
    ) {
        xDown = yDown = null;
        tCount = undefined;
        return;
    }
    e.preventDefault();
    tCount = e.touches.length;
    if (tCount === 4) {
        touch_locked = !touch_locked;
        alert(_(touch_locked ? "Touchscreen locked" : "Touchscreen unlocked"));
    }
    if (touch_locked) return;
    xDown = e.touches[0].screenX;
    yDown = e.touches[0].screenY;
    xUp = xDown;
    yUp = yDown;
    xMove1 = xDown;
    yMove1 = yDown;
    startNativeListTouch(e);
}

/**
 * Handle the `touchmove` event on the document body.
 * For single-finger moves, detects a swipe beyond the configured distance and dispatches the corresponding
 * arrow key (LEFT, RIGHT, UP, DOWN) via `window._doKey`.
 *
 * @param e - The TouchEvent object (typed as `any` for compatibility).
 * @returns void — early return if `xDown` or `yDown` is null (no touchstart recorded).
 * @sideeffect Calls `e.preventDefault()`. Dispatches key events via `window._doKey`.
 *             Updates module-level `xUp`, `yUp`, `xMove1`, `yMove1`.
 * @analysis Only processes single-finger (tCount === 1) moves. Multi-finger moves are ignored here
 *             (handled on touchend). Small movements accumulate until a swipe threshold is crossed.
 *             A non-zero dir causes the move reference point to be reset to prevent repeated dispatches.
 */
function handleTouchMove(e: any): void {
    if (touch_locked || xDown === null || yDown === null) return;
    e.preventDefault();
    updateTouchPosition(e.touches[0]);
    if (moveNativeListTouch(e.touches[0])) return;
    if (tCount === 1) {
        var dir = getDirection(
            xMove1!,
            yMove1!,
            xUp!,
            yUp!,
            touch_min_sensX,
            touch_min_sensY
        );
        if (dir === 1) (window as any)._doKey((window as any).keys.LEFT);
        else if (dir === 4) (window as any)._doKey((window as any).keys.RIGHT);
        else if (dir === 2) (window as any)._doKey((window as any).keys.DOWN);
        else if (dir === 8) (window as any)._doKey((window as any).keys.UP);
        if (dir) {
            yMove1 = yUp;
            xMove1 = xUp;
        }
    }
}

/**
 * Handle the `touchend` event on the document body.
 * Maps multi-finger gestures to remote control keys:
 * - 3-finger tap → SETUP
 * - 2-finger swipe → color keys (RED/GREEN/YELLOW/BLUE) or tap → ENTER
 * - 1-finger tap → synthesizes a MouseEvent click on the target element
 *
 * @param e - The TouchEvent object (typed as `any` for compatibility).
 * @returns void — early return if `xDown` or `yDown` is null.
 * @sideeffect Calls `e.preventDefault()`. Dispatches key events via `window._doKey`.
 *             Dispatches a synthetic `click` MouseEvent on the touch target.
 *             Resets tracking state (`xDown`, `yDown`, `tCount`) after processing.
 * @analysis Only processes when `e.touches.length === 0` (finger lifted). Two-finger tap detection
 *             uses checkTap with a tighter threshold. One-finger tap creates a proper MouseEvent
 *             so that regular click handlers fire naturally.
 */
function body_handleTouchEnd(e: any): void {
    if (xDown === null || yDown === null) return;
    e.preventDefault();
    if (e.touches.length === 0) {
        // Some WebViews coalesce the last movement into touchend.
        if (tCount === 1) updateTouchPosition(e.changedTouches[0]);
        if (nativeListTouch) moveNativeListTouch(e.changedTouches[0]);
        if (nativeListTouch?.cancelled) {
            handleTouchCancel();
            return;
        }
        if (tCount === 3) {
            // 3-finger tap → SETUP
            if (
                checkTap(
                    xDown!,
                    yDown!,
                    xUp!,
                    yUp!,
                    touch_min_sensX * 5,
                    touch_min_sensY * 2
                )
            )
                (window as any)._doKey((window as any).keys.SETUP);
        } else if (tCount === 2) {
            // 2-finger gestures → color keys or ENTER
            var dir = getDirection(
                xDown!,
                yDown!,
                xUp!,
                yUp!,
                touch_min_sensX,
                touch_min_sensY * 2
            );
            switch (dir) {
                case 0:
                    if (
                        checkTap(
                            xDown!,
                            yDown!,
                            xUp!,
                            yUp!,
                            touch_min_sensX / 2,
                            touch_min_sensY / 2
                        )
                    )
                        (window as any)._doKey((window as any).keys.ENTER);
                    break;
                case 1:
                    (window as any)._doKey((window as any).keys.RED);
                    break;
                case 4:
                    (window as any)._doKey((window as any).keys.BLUE);
                    break;
                case 2:
                    (window as any)._doKey((window as any).keys.YELLOW);
                    break;
                case 8:
                    (window as any)._doKey((window as any).keys.GREEN);
                    break;
            }
        } else if (tCount === 1) {
            // Preserve the TS click target and coordinates in every shell.
            if (
                !nativeListTouch?.moved &&
                // Retain checkTap's tolerance, but measure the whole gesture
                // so returning to its starting point cannot activate a control.
                touchMaxDistance < touch_min_sensX / 10
            ) {
                var touch = e.changedTouches[0];
                var clickEvent: MouseEvent;
                try {
                    clickEvent = new MouseEvent("click", {
                        bubbles: true,
                        cancelable: true,
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        view: window,
                    });
                } catch (_legacyMouseEvent) {
                    // Old WebKit exposes MouseEvents through createEvent only.
                    clickEvent = document.createEvent("MouseEvents");
                    clickEvent.initMouseEvent(
                        "click",
                        true,
                        true,
                        window,
                        1,
                        touch.screenX || 0,
                        touch.screenY || 0,
                        touch.clientX,
                        touch.clientY,
                        false,
                        false,
                        false,
                        false,
                        0,
                        null
                    );
                }
                // Only a stationary native list gesture activates on its first
                // tap. Mouse clicks and remote navigation retain their policy.
                (clickEvent as any).ottNativeListTap = !!nativeListTouch;
                e.target.dispatchEvent(clickEvent);
            }
        }
        if (tCount === 1) startNativeListInertia();
        xDown = null;
        yDown = null;
        tCount = undefined;
        touchMaxDistance = 0;
        resetNativeListTouch();
    }
}

/**
 * Visible viewport height for click-band geometry.
 * Prefer window.innerHeight / visualViewport — never body getBoundingClientRect
 * alone (oversized body makes the bottom band unreachable → every click is middle).
 */
export function ottBandViewportHeight(): number {
    try {
        const ih =
            typeof window.innerHeight === "number" ? window.innerHeight : 0;
        const vv =
            window.visualViewport &&
            typeof window.visualViewport.height === "number"
                ? window.visualViewport.height
                : 0;
        if (ih > 0 && vv > 0) return Math.min(ih, vv);
        if (ih > 0) return ih;
        if (vv > 0) return vv;
        const docEl = document.documentElement;
        const docH =
            docEl && typeof docEl.clientHeight === "number"
                ? docEl.clientHeight
                : 0;
        if (docH > 0) return docH;
    } catch (_vh) {}
    return 0;
}

/**
 * Y where the bottom info band starts (clientY above this → showChannelInfo).
 * Wider than legacy 20%: ~30% of viewport or at least ~140 CSS px.
 */
export function ottBottomInfoBandStart(h: number): number {
    const band = Math.max(h * 0.3, 140);
    return h - band;
}

/**
 * Handle `click` events on the document body (assigned to `document.body.onclick`).
 * Interprets the vertical click position:
 * - Top 20% → open popup menu (popupList)
 * - Bottom ~30% (min ~140px) → show channel info (showChannelInfo)
 * - Middle → dispatch ENTER key
 *
 * @param e - The MouseEvent object (typed as `any` for compatibility).
 * @returns void — early return if `e.clientY` is undefined.
 * @sideeffect Calls `window.popupList()`, `window.showChannelInfo()`, or `window._doKey(keys.ENTER, e)`.
 * @analysis Uses `ottBandViewportHeight()` (innerHeight / visualViewport), not body rect alone.
 */
function body_onClick(e: any): void {
    if (!e) e = event as any;
    // After a real window drag (mousedown→move→mouseup), ignore the synthetic
    // click so Channel list / menus do not open from the drag release.
    if ((window as any).__ottTauriSuppressClick) return;
    // Tauri mouseup already showed the info bar for a video-surface bottom
    // click (WKWebView sometimes omits the following click entirely).
    if ((window as any).__ottInfoBandFromMouseUp) return;
    if (e.clientY === undefined) return;
    // Channel list / OSD / edit open: footer renderButtonHint clicks must not also hit
    // the bottom-band showChannelInfo / middle ENTER (looked like dead buttons).
    try {
        if (typeof $ !== "undefined") {
            if (
                $("#list_window").is(":visible") ||
                $("#list_osd").is(":visible") ||
                $("#listEdit").is(":visible")
            ) {
                return;
            }
        } else if ((window as any).isListVisible) {
            return;
        }
    } catch (_listOpen) {}
    var t = ottBandViewportHeight();
    if (!(t > 0)) return;
    if (e.clientY < t * 0.2) (window as any).popupList();
    else if (e.clientY > ottBottomInfoBandStart(t)) {
        try {
            if (typeof e.preventDefault === "function") e.preventDefault();
            if (typeof e.stopPropagation === "function") e.stopPropagation();
        } catch (_sp) {}
        (window as any).showChannelInfo();
    } else (window as any)._doKey((window as any).keys.ENTER, e);
}

/**
 * Handle click events when the list overlay is visible — dispatches a RETURN key to close/go back.
 *
 * @param e - The MouseEvent object (typed as `any` for compatibility).
 * @returns void
 * @sideeffect Calls `window._doKey(keys.RETURN, e)`.
 */
export function list_OnClick(e: any): void {
    if (!e) e = event as any;
    if ((window as any).__ottTauriSuppressClick) return;
    (window as any)._doKey((window as any).keys.RETURN, e);
}

document.body.addEventListener("touchstart", handleTouchStart, {
    passive: false,
});
document.body.addEventListener("touchmove", handleTouchMove, {
    passive: false,
});
document.body.addEventListener("touchend", body_handleTouchEnd, {
    passive: false,
});
document.body.addEventListener("touchcancel", handleTouchCancel);
// Bubble on body (browser / non-video targets). Tauri also attaches a
// capture-phase video-surface listener in src/index.ts because WKWebView
// <video> clicks often never reach body.onclick.
document.body.onclick = body_onClick;
installKeyboardSeek();
