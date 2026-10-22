version += " samsung-tizen-0219";
// Samsung TV Web keycodes, not the legacy platform's remote constants.
// https://developer.samsung.com/smarttv/develop/guides/user-interaction/remote-control.html
var keys = {
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
var strEXIT = "RETURN";
var strENTER = "ENTER";
var strTools = "TOOLS";
var strRETURN = "RETURN";
var strSETUP = "MENU";
function registerTizenRemoteKeys() {
    var input;
    try {
        input = window.tizen && window.tizen.tvinputdevice;
        if (!input || typeof input.registerKey !== "function") return;
    } catch (e) {
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
        } catch (e) {
            // One unavailable key or privilege must not stop player startup
            // or prevent registration of the remaining supported keys.
        }
    }
}
// Capture the existing initializer before assigning the device wrapper.
var _baseStbInit = typeof stbInit === "function" ? stbInit : function () {};
stbInit = function () {
    var baseInitResult = _baseStbInit.apply(this, arguments);
    registerTizenRemoteKeys();
    try {
        if (typeof tizen !== "undefined") {
            console.log("[stb] Samsung Tizen platform detected");
        }
    } catch (e) {}
    return baseInitResult;
};
