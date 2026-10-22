version += " samsung-maple-0219";
var keys = {
    ASPECT: 0,
    AUDIO: 0,
    BLUE: 33,
    CH_DOWN: 19,
    CH_LIST: 107,
    CH_UP: 18,
    DOWN: 5,
    ENTER: 12,
    EPG: 0,
    EXIT: 45,
    FF: 72,
    GREEN: 30,
    INFO: 99,
    LANG: 0,
    LEFT: 4,
    MUTE: 82,
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
    NEXT: 69,
    PAUSE: 75,
    PIP: 0,
    PLAY: 71,
    POWER: 0,
    PRECH: 108,
    PREV: 68,
    REC: 0,
    RED: 29,
    RETURN: 88,
    RIGHT: 6,
    RW: 74,
    SETUP: 31,
    STOP: 73,
    TOOLS: 31,
    UP: 8,
    VOL_DOWN: 17,
    VOL_UP: 16,
    YELLOW: 32,
    ZOOM: 0,
};
var strEXIT = "EXIT";
var strRETURN = "RETURN";
// Capture the existing initializer before assigning the device wrapper.
var _baseStbInit = typeof stbInit === "function" ? stbInit : function () {};
stbInit = function () {
    var baseInitResult = _baseStbInit.apply(this, arguments);
    try {
        if (typeof Common !== "undefined" && Common.API) {
            console.log("[stb] Samsung Maple (Orsay) platform detected");
        }
    } catch (e) {}
    return baseInitResult;
};
