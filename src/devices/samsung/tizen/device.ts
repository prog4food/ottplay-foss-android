/**
 * Samsung Tizen device stub.
 *
 * Keycodes and platform-specific init for Samsung Tizen TVs.
 * Sets window.keys and overrides stbInit.
 */

import { stbInit as baseStbInit } from "../../../core";

// https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
var tizenKeys = {
    ASPECT: 10140,
    AUDIO: 10195,
    BLUE: 406,
    CH_DOWN: 428,
    CH_LIST: 10073,
    CH_UP: 427,
    DOWN: 40,
    ENTER: 13,
    EPG: 458,
    EXIT: 10182,
    FF: 417,
    GREEN: 404,
    INFO: 457,
    LANG: 0,
    LEFT: 37,
    MUTE: 449,
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
    NEXT: 10233,
    PAUSE: 19,
    PIP: 0,
    PLAY: 415,
    PLAYPAUSE: 10252,
    POWER: 10005,
    PRECH: 10190,
    PREV: 10232,
    REC: 416,
    RED: 403,
    RETURN: 10009,
    RIGHT: 39,
    RW: 412,
    SETUP: 18,
    STOP: 413,
    TOOLS: 10135,
    UP: 38,
    VOL_DOWN: 448,
    VOL_UP: 447,
    YELLOW: 405,
    ZOOM: 10122,
};

// Set globals expected by the player
(window as any).keys = tizenKeys;
(window as any).strEXIT = "RETURN";
(window as any).strENTER = "ENTER";
(window as any).strTools = "TOOLS";
(window as any).strRETURN = "RETURN";
(window as any).strSETUP = "MENU";

function registerTizenRemoteKeys(): void {
    var input: any;
    try {
        input = (window as any).tizen && (window as any).tizen.tvinputdevice;
        if (!input || typeof input.registerKey !== "function") return;
    } catch {
        return;
    }
    // Arrows, Enter and Back arrive automatically. Other keys require the
    // tv.inputdevice privilege in the containing Tizen application's manifest.
    var names = [
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
        "VolumeUp",
        "VolumeDown",
        "VolumeMute",
        "ChannelUp",
        "ChannelDown",
        "ChannelList",
        "PreviousChannel",
        "MediaPlayPause",
        "MediaRewind",
        "MediaFastForward",
        "MediaPlay",
        "MediaPause",
        "MediaStop",
        "MediaRecord",
        "MediaTrackPrevious",
        "MediaTrackNext",
        "ColorF0Red",
        "ColorF1Green",
        "ColorF2Yellow",
        "ColorF3Blue",
        "Menu",
        "Tools",
        "Info",
        "Exit",
        "PictureSize",
        "MTS",
        "Guide",
    ];
    for (var i = 0; i < names.length; i++) {
        try {
            input.registerKey(names[i]);
        } catch {
            // Keep startup and the remaining keys working if a key or the
            // containing application's tv.inputdevice privilege is unavailable.
        }
    }
}

// Hide Samsung launch splash — Tizen 5.5+ exposes setSplashEnabled on webapis.appcommon
function hideSplash(): void {
    try {
        const webapis = (window as any).webapis;
        if (webapis?.appcommon?.setSplashEnabled) {
            webapis.appcommon.setSplashEnabled(false);
        }
    } catch {
        // ponytail: degrade silently
    }
}

// Hide smart-remote cursor — Tizen SDK has no setCursorVisible JS API, use CSS
function hideCursor(): void {
    try {
        document.documentElement.style.cursor = "none";
        document.body.style.cursor = "none";
    } catch {
        // ponytail: degrade silently
    }
}

// Lock window to landscape — Tizen supports portrait, we don't
function lockLandscape(): void {
    try {
        const so = (screen as any).orientation;
        if (so?.lock) {
            so.lock("landscape").catch(() => {
                /* ponytail: some Tizen builds reject; ignore */
            });
        }
    } catch {
        // ponytail: degrade silently
    }
}

// Bring app to foreground — prevent OS from stealing focus during playback
function focusApp(): void {
    try {
        const tizen = (window as any).tizen;
        if (tizen?.application?.getCurrentApplication) {
            tizen.application.getCurrentApplication().requestForeground();
        }
        if (typeof window.focus === "function") window.focus();
    } catch {
        // ponytail: degrade silently
    }
}

// Override stbInit with Tizen-specific init
function stbInit(): void {
    baseStbInit();
    registerTizenRemoteKeys();
    const win = window as any;
    if (typeof win.tizen === "undefined") {
        return;
    }
    console.log("[stb] Samsung Tizen platform detected");
    hideSplash();
    hideCursor();
    lockLandscape();
    focusApp();
}
(window as any).stbInit = stbInit;
