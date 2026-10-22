var stb = null;
var video = null,
    videopip = null;
var stbPlayers = ["html5", "hls.js", "shaka"];
var strEXIT = "Esc";
var strENTER = "ENTER";
var strTools = '<span class="fontello">&#xe808;</span>';
var strInfo = '<span class="fontello">&#xe810;</span>';
var strEPG = "";
var strPip = "W";
var strAspect = "A";
var strZoom = "E";
var strAudio = "S";
var strPRECH = "?";
var strRETURN = '<span class="fontello">&#xe804;</span>';
var strSETUP = "\u00a7";
var strLANG = "SHIFT";

function stbEventToKeyCode(event) {
    if (event.keyCode == 76) {
        if (isNormalScreen()) openFullscreen();
        else closeFullscreen();
    }
    return event.keyCode;
}
function isNormalScreen() {
    try {
        return !(
            document.fullscreen ||
            document.mozFullScreen ||
            document.webkitFullScreen ||
            document.msRequestFullscreen
        );
    } catch (e) {
        return true;
    }
}
function openFullscreen() {
    var elem = document.documentElement;
    if (elem.requestFullscreen) elem.requestFullscreen();
    else if (elem.mozRequestFullScreen) elem.mozRequestFullScreen();
    else if (elem.webkitRequestFullscreen) elem.webkitRequestFullscreen();
    else if (elem.msRequestFullscreen) elem.msRequestFullscreen();
}
function closeFullscreen() {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    else if (document.msExitFullscreen) document.msExitFullscreen();
}
function stbExit() {
    if (window.__ottRemoteInputActive) return;
    window.close();
}

var hls = null,
    player = null;
function stbPlay(url, pos) {
    if (pos) url += "#t=" + pos;
    if (hls) {
        hls.destroy();
        hls = null;
    }
    if (player) {
        player = null;
    }
    if (sPlayers === 1 && typeof Hls !== "undefined" && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function () {});
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, function (eventName, _a) {
            var audioTracks = _a.audioTracks;
            execCHarr("aAudios", function (ind) {
                console.log("PreSet audioTrack");
                if (hls) hls.audioTrack = ind;
            });
        });
        execCHarr("aSubs", function (ind) {
            if (hls) hls.subtitleTrack = ind - 1;
        });
    } else if (
        sPlayers === 2 &&
        typeof shaka !== "undefined" &&
        shaka.Player &&
        shaka.Player.isBrowserSupported()
    ) {
        var player = new shaka.Player(video);
        window.player = player;
        try {
            player.load(url);
            video.play();
        } catch (e) {
            console.error(e);
        }
    } else {
        video.src = url;
    }
    video.play();
}
function stbStop() {
    video.pause();
    video.removeAttribute("src");
    if (hls) hls.destroy();
}
function stbPause() {
    video.pause();
}
function stbContinue() {
    video.paused ? video.play() : video.pause();
}
function stbIsPlaying() {
    return !video.paused;
}
function stbToggleMute() {
    video.muted = !video.muted;
}
function stbGetVolume() {
    return video.volume * 100;
}
function stbSetVolume(value) {
    video.volume = value / 100;
}
function stbGetPosTime() {
    return video.currentTime;
}
function stbSetPosTime(value) {
    video.currentTime = value;
    if (playType < 0) updateMediaInfo();
}
function stbGetLen() {
    return video.duration;
}
function stbToFullScreen() {
    _full = true;
    $("#video").css({ height: "100%", left: 0, top: 0, width: "100%" });
    $("#vdiv").css({ height: "100%", left: 0, top: 0, width: "100%" });
    _aspect();
}
function stbSetWindow() {
    _full = false;
    var lh = getHeightK(),
        lw = getWidthK();
    $("#vdiv").css({
        height: 288 * lh,
        left: sListPos ? 758 * lw : 10 * lw,
        top: 50 * lh,
        width: 512 * lw,
    });
    $("#video").css({ height: "100%", left: 0, top: 0, width: "100%" });
}
function stbInfo() {
    $("#listAbout").append(
        "<br/>userAgent: " +
            navigator.userAgent +
            "<br/>appCodeName: " +
            navigator.appCodeName +
            "<br/>appName: " +
            navigator.appName +
            "<br/>appVersion: " +
            navigator.appVersion +
            "<br/>platform: " +
            navigator.platform
    );
    $.get("http://api.ipify.org", function (data) {
        $("#listAbout").append("<br/>Ip address: " + data);
    });
}
var _full = true,
    aspect = 0;
function _setAspect(val) {
    aspect = val;
    _aspect();
}
function _aspect() {
    var arrayRatio = ["contain", "cover"];
    $("#video").css("object-fit", arrayRatio[aspect]);
}
function stbToggleAspectRatio() {
    showSelectBox(
        aspect,
        [_("Fit to screen"), _("Fill screen")],
        function (val) {
            _setAspect(val);
            saveCHarr("aAspects", val);
        }
    );
}
function _setAudioTrack(ind) {
    if (hls) {
        if (hls.audioTrack != ind) hls.audioTrack = ind;
        return;
    }
    var at = video.audioTracks;
    for (var i = 0; i < at.length; i++) at[i].enabled = i == ind;
}
function stbToggleAudioTrack() {
    var z = 0,
        curTrack = 0,
        at = (hls || video).audioTracks,
        al = [];
    if (hls) curTrack = hls.audioTrack;
    for (var i = 0; i < at.length; i++) {
        if (hls) {
            if (curTrack == i) z = i;
        } else {
            if (at[i].enabled) z = i;
        }
        al.push(
            i +
                1 +
                "/" +
                at.length +
                " (" +
                (at[i].label || at[i].name) +
                "/" +
                (at[i].language || at[i].lang) +
                ")"
        );
    }
    showSelectBox(
        z,
        al,
        function (val) {
            if (val == z) return;
            _setAudioTrack(val);
            saveCHarr("aAudios", val);
        },
        -1
    );
}
function _setSubtitleTrack(ind) {
    if (hls) {
        hls.subtitleTrack = ind - 1;
        return;
    }
    var tt = video.textTracks;
    for (var i = 0; i < tt.length; i++)
        tt[i].mode = i == ind - 1 ? "showing" : "disabled";
}
function stbToggleSubtitle() {
    var z = 0,
        tt = video.textTracks,
        al = [tt.length ? _("Off") : _("Not found")];
    if (hls) {
        tt = hls.subtitleTracks;
        z = hls.subtitleTrack + 1;
    }
    for (var i = 0; i < tt.length; i++) {
        if (tt[i].mode == "showing") z = i + 1;
        al.push(
            i +
                1 +
                "/" +
                tt.length +
                " (" +
                (tt[i].label || tt[i].name) +
                "/" +
                (tt[i].language || tt[i].lang) +
                ")"
        );
    }
    showSelectBox(
        z,
        al,
        function (val) {
            if (val == z) return;
            _setSubtitleTrack(val);
            saveCHarr("aSubs", val);
        },
        -1
    );
}
function stbAudioTracksExists() {
    var _v = hls || video;
    return _v && _v.audioTracks ? _v.audioTracks.length > 1 : false;
}
function stbSubtitleExists() {
    if (hls) return hls.subtitleTracks.length;
    return video.textTracks.length;
}

function editKey2(code) {
    switch (code) {
        case keys.ENTER:
            editvar = $("#editvar").val();
            setEdit();
        case keys.EXIT:
            $("#listEdit").hide();
            restoreCPD();
    }
}
function showEditKey2() {
    saveCPD();
    listCaption.textContent = editCaption;
    var panel = $("#listEdit")
        .show()
        .html(
            '<br/><br/><br/><input type="text" id="editvar" style="background-color: black; font-size:150%; width: 95%;" autofocus><br/><br/>' +
                "<br/>" +
                btnDiv(keys.EXIT, strEXIT, "- return without save") +
                "<br/>" +
                btnDiv(keys.ENTER, strENTER, "- save")
        );
    panel.prepend(document.createTextNode(editCaption + ":"));
    var input = document.getElementById("editvar");
    input.value = editvar;
    input.style.color = curColor;
    input.focus();
}
var hlsp = null;
function stbPlayPip(url) {
    if (sPlayers === 1 && typeof Hls !== "undefined" && Hls.isSupported()) {
        if (hlsp) hlsp.destroy();
        hlsp = new Hls();
        hlsp.loadSource(url);
        hlsp.attachMedia(videopip);
        hlsp.on(Hls.Events.MANIFEST_PARSED, function () {});
    } else {
        videopip.src = url;
    }
    videopip.play();
    $("#videopip").show();
}
function stbStopPip() {
    videopip.pause();
    videopip.src = "";
    if (hlsp) hlsp.destroy();
    $("#videopip").hide();
    $("#pip_buffering").hide();
}
function setPipPos() {
    function setPipWindowRect(x, y, width, height) {
        $("#videopip").css({ height: height, left: x, top: y, width: width });
    }
    var lw = getWidthK(),
        lh = getHeightK(),
        ll = Math.min(lw, lh),
        ls = Math.max(lw, lh);
    ps = [
        { x: 256, y: 144 },
        { x: 384, y: 216 },
        { x: 512, y: 288 },
    ];
    $("#videopip").css({
        height: ps[sPipSize].y * ll,
        width: ps[sPipSize].x * ll,
    });
    switch (sPipPos) {
        case 0:
            $("#videopip").css({ right: 20 * ll, top: 20 * ll });
            return;
        case 1:
            $("#videopip").css({ bottom: 20 * ll, right: 20 * ll });
            return;
        case 2:
            $("#videopip").css({ bottom: 20 * ll, left: 20 * ll });
            return;
        case 3:
            $("#videopip").css({ left: 20 * ll, top: 20 * ll });
            return;
    }
}
var stbBufferSizes = ["0", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
function stbSetBuffer() {
    try {
        var buf = Number.parseInt(sBufSize || stbGetItem("sBufSize"), 10);
        if (!isNaN(buf) && buf > 0 && video) {
            video.preload = "auto";
            if (typeof video.buffered !== "undefined" && buf > 3) {
                console.log("[stb] buffer set to " + buf + "s");
            }
        }
    } catch (e) {
        console.error("[stb] stbSetBuffer error:", e);
    }
}
function stbOptions() {
    function saveSettings() {
        i = -1;
        if (sEditor != listArray[++i].val) {
            sEditor = listArray[i].val;
            stbSetItem("sEditor", sEditor);
        }
        if (sPlayers != listArray[++i].val) {
            sPlayers = listArray[i].val;
            providerSetItem("sPlayers", sPlayers);
        }
        if (sBufSize != listArray[++i].val) {
            sBufSize = listArray[i].val;
            stbSetItem("sBufSize", sBufSize);
        }
        setEditor();
        stbSetBuffer();
        showShift(_("Settings saved"));
        closeList();
        optionsList(stbOptions);
    }
    var noyes = [_("no"), _("yes")];
    var settingsArray = [
        {
            name: _("Editor"),
            val: sEditor,
            values: [_("built-in"), _("native")],
        },
        {
            name: _("Type of player for streaming"),
            val: sPlayers,
            values: stbPlayers,
        },
        { name: _("Buffer Size, s"), val: sBufSize, values: stbBufferSizes },
        { cur: "", name: "", val: 0, values: nofun },
        {
            cur: "",
            name: '<div class="btn">' + _("Save Settings") + "</div>",
            val: 0,
            values: saveSettings,
        },
    ];
    listArray = settingsArray;
    listCaption.innerHTML = _("Settings STB");
    _setSetup(saveSettings, function () {
        optionsList(stbOptions);
    });
}
function addAoptions() {
    optionsArr.splice(optIndexOf(parentControlSetup), 0, {
        action: stbOptions,
        name: "Settings STB",
    });
    optionsArr.splice(
        optIndexOf(selectLang) + 1,
        0,
        {},
        { name: "Save settings to storage" },
        { name: "Load settings from storage" }
    );
}
function unload() {
    stbStop();
}
var stb = {};
stb.getMacAddress = function () {
    return (
        stbGetItem(ott_device + "_mac") ||
        (function () {
            var _mac = "XX:XX:XX:XX:XX:XX".replace(/X/g, function () {
                return "0123456789abcdef".charAt(
                    Math.floor(Math.random() * 16)
                );
            });
            stbSetItem(ott_device + "_mac", _mac);
            return _mac;
        })()
    );
};
var _Dec = 0;
function videoEvent(event) {
    if (event && event.type) {
        console.log("[video] event: " + event.type);
        if (event.type === "error") {
            var mediaError = video ? video.error : null;
            if (mediaError) {
                console.error(
                    "[video] MediaError: code=" +
                        mediaError.code +
                        " message=" +
                        mediaError.message
                );
                if (typeof client_feedb === "function")
                    client_feedb(
                        "video::ERR::code=" +
                            mediaError.code +
                            " msg=" +
                            mediaError.message
                    );
            }
        }
    }
}
function setTransform() {
    $("body").css(
        "transform",
        "scale(" +
            Math.min(window.innerWidth / wi, window.innerHeight / hi) +
            ")"
    );
}
function setPlayer() {
    if (
        !(
            providerHasItemValue("sPlayers") ||
            video.canPlayType("application/vnd.apple.mpegurl")
        )
    ) {
        sPlayers = 1;
    }
}
document.body.style.cursor = "pointer";
function stbBindKeyHandler() {
    var w = window;
    if (typeof w.__ottKeydownListener !== "function") {
        w.__ottKeydownListener = function (event) {
            if (typeof w.keyHandler === "function") w.keyHandler(event);
        };
    }
    // Replace the previous property binding without delivering a key twice.
    w.onkeydown = null;
    if (typeof w.addEventListener === "function") {
        w.addEventListener("keydown", w.__ottKeydownListener, false);
    } else {
        w.onkeydown = w.__ottKeydownListener;
    }
}
function stbInit() {
    $("body").css({ "background-color": "#111" });
    window.addEventListener("resize", function () {
        if (typeof setFontSize === "function") setFontSize();
        if (typeof setListPos === "function") setListPos();
        if (typeof setColor === "function") setColor();
        if (list && list.style.display != "none") {
            if (typeof closeList === "function") closeList();
            if (typeof showPage === "function") showPage();
        }
    });
    try {
        if (document.getElementById("launch"))
            $("#launch").append(_("<br/>Loading STB..."));
        if (!document.getElementById("vdiv")) {
            $("body").prepend(
                '<div id="vdiv" style="position: absolute; overflow: hidden; background-color: black;"><video id="video" style="position: absolute; object-position: center center;"></video></div><video id="videopip" muted style="position: absolute; display: none; background-color: black; object-position: center center;"></video>'
            );
        }
        video = document.getElementById("video");
        // Suppress Android WebView's default play icon, including the PiP surface.
        $("video").attr(
            "poster",
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="
        );
        video.addEventListener("waiting", function () {
            $("#buffering").show();
            $("#video_res").html("<br/>connect...");
        });
        video.addEventListener("loadstart", function () {
            $("#buffering").show();
            $("#video_res").html("<br/>buffering...");
        });
        video.addEventListener("loadeddata", function () {
            console.log("Event: loadeddata");
        });
        video.addEventListener("loadedmetadata", function () {
            console.log("Event: loadedmetadata");
        });
        video.addEventListener("durationchange", function () {
            if (playType < 0) updateMediaInfo();
        });
        video.addEventListener("canplay", function () {
            $("#buffering").hide();
            $("#video_res").text("");
            if (playType < 0) updateMediaInfo();
            if (video.videoWidth)
                $("#video_res").html(
                    "<br/>" + video.videoWidth + "x" + video.videoHeight
                );
            if (typeof execCHarr === "function") {
                execCHarr("aAspects", _setAspect);
                execCHarr("aSubs", _setSubtitleTrack);
                execCHarr("aAudios", _setAudioTrack);
            }
        });
        video.addEventListener("playing", function () {
            $("#buffering").hide();
        });
        video.addEventListener("error", function () {
            var me = ["", "ABORTED", "NETWORK", "DECODE", "SRC_NOT_SUPPORTED"];
            console.log(
                "video > error: " +
                    (video.error.code || "") +
                    "-" +
                    (me[video.error.code] || video.error.code) +
                    (video.error.message
                        ? " (" + video.error.message + ")"
                        : "")
            );
            $("#buffering").hide();
            $("#video_res").html("<br/>error " + video.error.code);
        });
        video.addEventListener("resize", function () {
            if (video.videoWidth)
                $("#video_res").html(
                    "<br/>" + video.videoWidth + "x" + video.videoHeight
                );
        });
        [
            "waiting",
            "loadstart",
            "loadeddata",
            "loadedmetadata",
            "durationchange",
            "canplay",
            "canplaythrough",
            "playing",
            "error",
            "progress",
            "ratechange",
            "ended",
            "suspend",
            "emptied",
            "stalled",
            "abort",
            "play",
            "pause",
            "resize",
        ].forEach(function (element) {
            video.addEventListener(element, videoEvent);
        });
        if (video.webkitVideoDecodedByteCount != undefined)
            setInterval(function () {
                if (
                    video.videoWidth &&
                    video.webkitVideoDecodedByteCount - _Dec > 0
                )
                    $("#video_res").html(
                        "<br/>" +
                            video.videoWidth +
                            "x" +
                            video.videoHeight +
                            "<br/>" +
                            Math.round(
                                (((video.webkitVideoDecodedByteCount - _Dec) *
                                    8) /
                                    1024 /
                                    1024) *
                                    100
                            ) /
                                100 +
                            " Mbps"
                    );
                _Dec = video.webkitVideoDecodedByteCount;
            }, 1000);
        videopip = document.getElementById("videopip");
        videopip.addEventListener("loadstart", function () {
            if (videopip.style.display != "none") $("#pip_buffering").show();
        });
        videopip.addEventListener("playing", function () {
            $("#pip_buffering").hide();
        });
    } catch (e) {
        console.error(e);
    }
    if (document.getElementById("launch"))
        $("#launch").append(_("<br/>Setup STB..."));
    if (isNaN(Number.parseInt(stbGetItem("sEditor")))) stbSetItem("sEditor", 1);
    stbToFullScreen();
    stbBindKeyHandler();
}
function stbCSS() {
    if (typeof stbGetItem !== "function") return;
    var css = stbGetItem("stb_custom_css");
    if (css) {
        var style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }
}
function stbToggleStandby() {
    console.log(
        "[stb] standby requested - not supported on " +
            (ott_device || "unknown")
    );
}
var _zoomLevel = 0;
var _zoomScales = [1, 1.25, 1.5, 1.75];
var _zoomLabels = ["100%", "125%", "150%", "175%"];
function applyZoom() {
    var scale = _zoomScales[_zoomLevel] || 1;
    var el = document.getElementById("video");
    if (el) {
        var tr = scale === 1 ? "" : "scale(" + scale + ")";
        el.style.transform = tr;
        el.style.webkitTransform = tr;
        el.style.transformOrigin = "center center";
        el.style.webkitTransformOrigin = "center center";
    }
    if (scale > 1) document.body.classList.add("stb-zoom");
    else document.body.classList.remove("stb-zoom");
}
function setZoom(v) {
    _zoomLevel = v;
    applyZoom();
}
function stbToggleZoom() {
    if (typeof showSelectBox === "function") {
        showSelectBox(_zoomLevel, _zoomLabels, function (v) {
            setZoom(v);
            if (typeof saveCHarr === "function") saveCHarr("aZooms", v);
        });
    } else {
        _zoomLevel = (_zoomLevel + 1) % _zoomScales.length;
        applyZoom();
    }
}
function saveOpt() {
    if (typeof stbGetAllItems !== "function") return;
    try {
        if (typeof portableSettingsSnapshot !== "function")
            throw new Error("Settings backup policy is unavailable");
        var items = portableSettingsSnapshot(stbGetAllItems());
        localStorage.setItem("stb_settings_backup", JSON.stringify(items));
        showShift(_("Settings saved to storage"));
    } catch (e) {
        console.error("[stb] saveOpt error:", e);
    }
}
function loadOpt() {
    try {
        var data = localStorage.getItem("stb_settings_backup");
        if (!data) {
            showShift(_("No saved settings found"));
            return;
        }
        if (typeof restoreLocalSettingsSnapshot !== "function")
            throw new Error("Settings backup policy is unavailable");
        restoreLocalSettingsSnapshot(JSON.parse(data));
        showShift(_("Settings loaded from storage"));
    } catch (e) {
        console.error("[stb] loadOpt error:", e);
    }
}
function setAutorun() {
    var autorun = stbGetItem("stb_autorun");
    if (autorun === "1") {
        console.log("[stb] autorun triggered");
        if (typeof startPlayer === "function") startPlayer();
    }
}
