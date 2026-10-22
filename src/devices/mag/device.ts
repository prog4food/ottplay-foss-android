/**
 * MAG STB device stub.
 *
 * Keycodes and platform-specific init for MAG STBs.
 * Sets window.keys and overrides stbInit.
 */

import { stbInit as baseStbInit } from "../../core";

var magKeys = {
    ASPECT: 0,
    AUDIO: 0,
    BLUE: 115,
    CH_DOWN: 34,
    CH_LIST: 0,
    CH_UP: 33,
    DOWN: 40,
    ENTER: 13,
    EPG: 0,
    EXIT: 27,
    FF: 70,
    GREEN: 113,
    INFO: 73,
    LANG: 16,
    LEFT: 37,
    MUTE: 77,
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
    PAUSE: 80,
    PIP: 0,
    PLAY: 68,
    POWER: 0,
    PRECH: 191,
    PREV: 188,
    REC: 0,
    RED: 112,
    RETURN: 8,
    RIGHT: 39,
    RW: 82,
    SETUP: 122,
    STOP: 83,
    TOOLS: 122,
    UP: 38,
    VOL_DOWN: 109,
    VOL_UP: 107,
    YELLOW: 114,
    ZOOM: 0,
};

// Set globals expected by the player
(window as any).keys = magKeys;
(window as any).strEXIT = "EXIT";
(window as any).strRETURN = "BACK";

// Override stbInit with MAG-specific init
function stbInit(): void {
    baseStbInit();
    try {
        if (typeof (window as any).gSTB !== "undefined") {
            console.log("[stb] MAG STB detected");
            var mac =
                typeof (window as any).gSTB.GetMACAddress === "function"
                    ? (window as any).gSTB.GetMACAddress()
                    : typeof (window as any).gSTB.GetDeviceMacAddress ===
                        "function"
                      ? (window as any).gSTB.GetDeviceMacAddress()
                      : "";
            if (mac && mac !== "") {
                (window as any).stbGetMacAddress = function () {
                    return mac;
                };
            }
        }
    } catch (e) {}
}
(window as any).stbInit = stbInit;
