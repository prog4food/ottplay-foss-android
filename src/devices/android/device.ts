/**
 * Android device stub.
 *
 * Keycodes and platform-specific init for Android TV.
 * Sets window.keys and overrides stbInit.
 */

import { stbInit as baseStbInit } from "../../core";

var androidKeys = {
    ASPECT: 0,
    AUDIO: 0,
    BLUE: 186,
    CH_DOWN: 168,
    CH_LIST: 0,
    CH_UP: 167,
    DOWN: 20,
    ENTER: 66,
    EPG: 0,
    EXIT: 4,
    FF: 90,
    GREEN: 184,
    INFO: 165,
    LANG: 0,
    LEFT: 21,
    MUTE: 91,
    N0: 7,
    N1: 8,
    N2: 9,
    N3: 10,
    N4: 11,
    N5: 12,
    N6: 13,
    N7: 14,
    N8: 15,
    N9: 16,
    NEXT: 87,
    PAUSE: 85,
    PIP: 0,
    PLAY: 85,
    POWER: 26,
    PRECH: 0,
    PREV: 88,
    REC: 0,
    RED: 183,
    RETURN: 4,
    RIGHT: 22,
    RW: 89,
    SETUP: 82,
    STOP: 86,
    TOOLS: 82,
    UP: 19,
    VOL_DOWN: 25,
    VOL_UP: 24,
    YELLOW: 185,
    ZOOM: 0,
};

// Set globals expected by the player
(window as any).keys = androidKeys;
(window as any).strEXIT = "BACK";
(window as any).strENTER = "OK";
(window as any).strRETURN = "BACK";
(window as any).strSETUP = "MENU";

// Override stbInit with Android-specific init
function stbInit(): void {
    baseStbInit();
    try {
        if (typeof (window as any).Android !== "undefined") {
            console.log("[stb] Android platform detected");
        }
    } catch (e) {}
}
(window as any).stbInit = stbInit;
