version += " kbc-0906";
p_pref = "kbc";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|ХХХ|Adults/i;
sPlayers = 0;

if (typeof stbGetItem === "function") {
    providerGetItem = function (e) {
        return stbGetItem(p_pref + e);
    };
    providerSetItem = function (e, r) {
        stbSetItem(p_pref + e, r);
    };
} else {
    providerGetItem = function (e) {
        return localStorage.getItem(p_pref + e);
    };
    providerSetItem = function (e, r) {
        localStorage.setItem(p_pref + e, r);
    };
}
providerDelItem = function (e) {
    return ottpStorage.del(p_pref + e);
};
providerHasItem = function (e) {
    return ottpStorage.has(p_pref + e);
};
providerHasItemValue = function (e) {
    return ottpStorage.hasValue(p_pref + e);
};

function _scheme() {
    if (typeof scheme === "string" && scheme) return scheme;
    try {
        if (
            typeof window !== "undefined" &&
            window.location &&
            window.location.protocol &&
            window.location.protocol.indexOf("http") === 0
        ) {
            return window.location.protocol + "//";
        }
    } catch (e) {}
    return "https://";
}

function getChannelPicon(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].logo || "" : "";
}

function getChannelUrl(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].url || "" : "";
}

function getArchiveUrl(ch_id, time, time_to) {
    var channel = chanels[ch_id];
    if (!channel) return "";
    return (
        OttPlayCore.providerArchiveUrl(
            "kb",
            channel.url || "",
            channel.caso || "",
            channel.ca || "",
            Number(time),
            Number(time_to),
            Date.now() / 1000,
            browserName() === "dune",
            0
        ) || ""
    );
}

if (typeof catsArray == "undefined") var catsArray = [];

function getChanelsArray(callback) {
    function loadPlaylist(url, success, cb) {
        operatorLoadPlaylist(url, success, cb, "quiet");
    }

    function getEpgList(cepg, cb) {
        if (!cList.length) {
            cb();
            return;
        }
        $(launch_id).append(_("epgs..."));
        $.ajax({
            complete: function () {
                cb();
            },
            data: { list: JSON.stringify(cepg) },
            method: "post",
            success: function (data) {
                if (data)
                    cList.forEach(function (val) {
                        if (data[val]) chanels[val].epg_url = data[val];
                    });
            },
            timeout: 120000,
            url: _scheme() + "epg.drm-play.com/m3u/gelist.php",
        });
    }

    function getLogoList(cepg, cb) {
        if (!cList.length) {
            cb();
            return;
        }
        $(launch_id).append(_("logos..."));
        $.ajax({
            complete: function () {
                cb();
            },
            data: { list: JSON.stringify(cepg) },
            method: "post",
            success: function (data) {
                if (data)
                    cList.forEach(function (val) {
                        if (data[val]) chanels[val].logo = data[val];
                    });
            },
            timeout: 120000,
            url: _scheme() + "epg.drm-play.com/m3u/geicons.php",
        });
    }

    function aSuccess(data) {
        var cepg = {},
            clogo = false;
        try {
            cList = [];
            chanels = {};
            cats = {};
            catsArray = [];
            var catalog = OttPlayCore.parseOperatorPlaylist(
                data,
                "kb-team",
                function (url) {
                    return murmurhash3_32_gc(url, 10);
                },
                []
            );
            cats = catalog.groups;
            catsArray = catalog.groupOrder;
            cList = catalog.ids;
            chanels = catalog.channels;
            catalog.entries.forEach(function (entry) {
                if (entry.generatedName)
                    entry.channel.channel_name = _("??? No channel name");
                var ci = entry.id,
                    channel = entry.channel,
                    epg = channel.epg,
                    tn = channel.tn,
                    cn = channel.channel_name,
                    utvg = channel.utvg,
                    logo = channel.logo;
                if (epg && utvg) cepg[ci] = { e: epg, n: tn || cn, u: utvg };
                else if (utvg) cepg[ci] = { n: cn, u: utvg };
                else cepg[ci] = { n: tn || cn };
                if (!logo) {
                    if (!clogo) clogo = {};
                    var tn_l = tn + "|" + utvg,
                        cn_l = cn + "|" + utvg;
                    clogo[ci] = utvg ? cn_l || tn_l : tn || cn;
                }
            });
            if (catalog.malformed) throw new Error("Malformed playlist entry");
        } catch (e) {
            console.log(
                "Exception: name " +
                    e.name +
                    ", message " +
                    e.message +
                    ", typeof " +
                    typeof e
            );
            alert(_("Failed to load channel list!"));
        }
        callback();
        getEpgList(cepg, function () {
            try {
                if (
                    typeof curList !== "undefined" &&
                    curList &&
                    curList[primaryIndex] &&
                    chanels[curList[primaryIndex]]
                ) {
                    chanels[curList[primaryIndex]].time_request = 0;
                    updateChanelInfo(curList[primaryIndex]);
                }
            } catch (ex) {}
        });
        if (clogo)
            getLogoList(clogo, function () {
                try {
                    if (
                        typeof curList !== "undefined" &&
                        curList &&
                        curList[primaryIndex]
                    )
                        updateChanelInfo(curList[primaryIndex]);
                } catch (ex) {}
            });
    }

    if (!OttPlayCore.operatorCredentialsValid("kb-team", box_mac || "", "")) {
        alert(_("Device MAC is required for KBC (Kinoboom) playlists"));
        callback();
        return;
    }
    var playlistUrl = OttPlayCore.operatorProfileUrl("kb-team", "playlist", {
        list: v_list,
        mac: box_mac,
    });
    loadPlaylist(playlistUrl, aSuccess, callback);
}

function getEPGurl(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].epg_url : null;
}

var _epgDomen = null;
function getEPGchanel(ch_id, callback) {
    if (!_epgDomen) _epgDomen = _scheme() + "epg.drm-play.com/";
    var d = null,
        epg_url = getEPGurl(ch_id);
    if (!epg_url) {
        callback(ch_id, d);
        return;
    }
    $.ajax({
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            if (data !== null) d = data.epg_data;
        },
        timeout: 10000,
        url: _epgDomen + encodeURIComponent(epg_url) + ".json",
    });
}

function xml2json1(xml, tab) {
    return operatorXmlToJson(xml, tab);
}

function getMediaArrayXML(murl, callback) {
    operatorLoadVod("kb-team", murl, callback);
}

function getMediaArrayEXTM3U(data) {
    operatorMediaPlaylist("kb-team", data);
}

var getMediaArray = function (murl, callback) {
    murl = OttPlayCore.operatorVodRoot("kb-team", murl, "");
    getMediaArrayXML(murl, callback);
};

var box_mac = "",
    edTlist = ["IPTV #1", "IPTV #2", "IPTV #3"];
p_pref = "kbc";
var v_list = parseInt(providerGetItem("v_list"), 10) || 0;

function _m3u2popup() {
    var b = _("Load:") + " " + edTlist[v_list];
    popupArray[popupActions.indexOf(doEditList)] =
        _("Built-in playlist:") + " " + edTlist[v_list];
    popupArray[popupActions.indexOf(loadVlist)] = b;
}

function duneAddSettings(ind) {
    try {
        if (
            typeof AndroidInterface !== "undefined" &&
            typeof AndroidInterface.getMac === "function"
        ) {
            if (AndroidInterface.getMac() == "02:00:00:00:00:00") {
                stb.getMacAddress = function () {
                    var m = stbGetItem("mac") || "";
                    if (!m) {
                        m = "44:5c:e9:XX:XX:XX".replace(/X/g, function () {
                            return "0123456789abcdef".charAt(
                                Math.floor(Math.random() * 16)
                            );
                        });
                        stbSetItem("mac", m);
                    }
                    return m;
                };
            }
        }
    } catch (e) {}

    box_mac = stb.getMacAddress().replace(/:/g, "");
    p_pref = "kbc";
    v_list = parseInt(providerGetItem("v_list"), 10) || 0;
    p_pref = "kbc" + v_list;
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10))) {
        providerSetItem("sShowArchive", 1);
    }
    if (isNaN(parseInt(stbGetItem("sNoSmall"), 10))) {
        stbSetItem("sNoSmall", 1);
        sNoSmall = 1;
    }
    box_mac = box_mac.toLowerCase();
    popupArray.splice(ind, 1, "", "", _("KBC (Kinoboom) access data"));
    popupDetail.splice(
        ind,
        1,
        _("Built-in playlists"),
        _("Load built-in playlist:") + " " + edTlist[v_list],
        _("KBC (Kinoboom) access data")
    );
    popupActions.splice(ind, 1, doEditList, loadVlist, doUserInfo);
    _m3u2popup();
}

function doEditList() {
    if (++v_list == edTlist.length) v_list = 0;
    _m3u2popup();
    popupList(doEditList);
}

function loadVlist() {
    p_pref = "kbc";
    providerSetItem("v_list", v_list);
    p_pref = "kbc" + v_list;
    providerSetItem("v_list", v_list);
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _m3u2popup();
    loadChannels();
}

function doUserInfo() {
    saveCPD();
    listCaption.innerHTML = _("KBC (Kinoboom) access data");
    aboutKeyHandler = function () {
        restoreCPD();
        $("#listAbout").hide();
        return true;
    };
    $("#listAbout").html(_("Loading. Please wait...")).show();
    $.ajax({
        dataType: "json",
        error: function (jqXHR, textStatus, errorThrown) {
            $("#listAbout").html(
                _("ERROR!") +
                    "<br/><br/>jqXHR:" +
                    JSON.stringify(jqXHR) +
                    "<br/>textStatus: " +
                    textStatus +
                    "<br/>errorThrown: " +
                    errorThrown
            );
        },
        success: function (data) {
            if (data && data.title == "KinoBoom User Info" && data.channels) {
                var s = "";
                data.channels.forEach(function (val) {
                    if (val.title != "Speedtest") s += val.title + "<br/>";
                });
                $("#listAbout").html(s);
            } else $("#listAbout").html(_("Failed to get user data!!!"));
        },
        timeout: 5000,
        url:
            "http://kb-team.club/info.php?box_client=ott-play&box_mac=" +
            box_mac,
    });
}
