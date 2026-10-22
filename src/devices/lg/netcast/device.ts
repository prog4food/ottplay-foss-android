/**
 * LG Netcast device stub.
 *
 * Keycodes for LG Netcast TVs.
 * Sets window.keys and overrides stbInit.
 */

import { stbInit as baseStbInit } from "../../../core";

var netcastKeys = {
    ASPECT: 0,
    AUDIO: 0,
    BLUE: 406,
    CH_DOWN: 428,
    CH_LIST: 0,
    CH_UP: 427,
    DOWN: 40,
    ENTER: 13,
    EPG: 0,
    EXIT: 27,
    FF: 70,
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
    NEXT: 190,
    PAUSE: 19,
    PIP: 0,
    PLAY: 415,
    POWER: 0,
    PRECH: 0,
    PREV: 188,
    REC: 416,
    RED: 403,
    RETURN: 8,
    RIGHT: 39,
    RW: 82,
    SETUP: 458,
    STOP: 413,
    TOOLS: 459,
    UP: 38,
    VOL_DOWN: 448,
    VOL_UP: 447,
    YELLOW: 405,
    ZOOM: 0,
};

// Set globals expected by the player
(window as any).keys = netcastKeys;
(window as any).strEXIT = "EXIT";
(window as any).strTools = "TOOLS";
(window as any).strRETURN = "BACK";

// Override stbInit with Netcast-specific init
function stbInit(): void {
    baseStbInit();
    try {
        console.log("[stb] LG Netcast platform detected");
    } catch (e) {}
}
(window as any).stbInit = stbInit;
