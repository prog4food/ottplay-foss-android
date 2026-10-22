/**
 * E2 device stub.
 *
 * Keycodes for E2 (Enigma2) STBs.
 * Sets window.keys.
 * stbInit: NO — legacy has no stbInit body
 */

var e2Keys = {
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
    LANG: 0,
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
    PLAY: 80,
    POWER: 0,
    PRECH: 0,
    PREV: 188,
    REC: 0,
    RED: 112,
    RETURN: 8,
    RIGHT: 39,
    RW: 82,
    SETUP: 84,
    STOP: 83,
    TOOLS: 84,
    UP: 38,
    VOL_DOWN: 0,
    VOL_UP: 0,
    YELLOW: 114,
    ZOOM: 0,
};

// Set globals expected by the player
(window as any).keys = e2Keys;
(window as any).strEXIT = "EXIT";
(window as any).strRETURN = "BACK";
