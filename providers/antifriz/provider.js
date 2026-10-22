version += " antifriz-0906";
var key, mpeg;
p_pref = "az";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults/i;
mp4 = false;

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

function _getParams() {
    key = providerGetItem("key") || "";
    mpeg = parseInt(providerGetItem("mpeg"), 10) || 0;
}

function getChannelPicon(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].logo || "" : "";
}

function getServ(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].server : "";
}

var __hls = navigator.userAgent.indexOf("Tizen") === -1 ? 0 : 2;

function getChannelUrl(ch_id) {
    return OttPlayCore.operatorLiveUrl(
        "antifriz",
        String(ch_id),
        chanels[ch_id],
        { hls: __hls, mode: mpeg }
    );
}

function getArchiveUrl(ch_id, time, time_to) {
    var channel = chanels[ch_id];
    return (
        OttPlayCore.providerArchiveUrl(
            "antifriz",
            "http://" + getServ(ch_id) + ":80/" + ch_id + "/",
            "?token=" + channel.token,
            "",
            Number(time),
            Number(time_to),
            Date.now() / 1000,
            browserName() === "dune",
            Number(mpeg || __hls)
        ) || ""
    );
}

if (typeof catsArray == "undefined") var catsArray = [];

function getChanelsArray(callback) {
    _getParams();

    function loadPlaylist(url, success, cb) {
        operatorLoadPlaylist(url, success, cb, "classic");
    }

    function aSuccess(data) {
        try {
            cList = [];
            chanels = {};
            cats = {};
            catsArray = [];
            var catalog = OttPlayCore.parseOperatorPlaylist(
                data,
                "antifriz",
                function () {
                    return 0;
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
            });
            if (catalog.malformed) throw new Error("Malformed playlist entry");
            if (!OttPlayCore.operatorCredentialsValid("antifriz", key, "")) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (ex) {}
                infoBox(
                    "Для доступа необходимо ввести ключ! (Ключ доступа для приложений - 8 символов)"
                );
            }
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
    }

    if (!OttPlayCore.operatorCredentialsValid("antifriz", key, "")) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox(
            "Для доступа необходимо ввести ключ! (Ключ доступа для приложений - 8 символов)"
        );
        callback();
        return;
    }

    loadPlaylist(
        OttPlayCore.operatorProfileUrl("antifriz", "playlist", { key: key }),
        aSuccess,
        callback
    );
}

if (typeof sNextCount == "undefined") sNextCount = -1;

function _getEPGchanel(ch_id, callback, all) {
    var d = [];
    var epgId = chanels[ch_id]
        ? chanels[ch_id].epg_id || chanels[ch_id].epg || ""
        : "";
    if (!epgId) {
        callback(ch_id, d);
        return;
    }
    $.ajax({
        cache: false,
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            if (data)
                data.forEach(function (val) {
                    d.push({
                        descr: val.descr,
                        name: val.name,
                        time: val.time,
                        time_to: val.time_to,
                    });
                });
        },
        timeout: 30000,
        url:
            "http://protected-api.com/epg/" +
            (all
                ? epgId + "?date="
                : "current/" + epgId + "?num=" + (sNextCount + 1)),
    });
}

function getEPGchanel(ch_id, callback) {
    _getEPGchanel(ch_id, callback, true);
}

function getEPGchanelCur(ch_id, callback) {
    _getEPGchanel(ch_id, callback, false);
}

/* xml2json — Stefan Goessner / Creative Commons GNU LGPL 2.1 */
function xml2json1(xml, tab) {
    return operatorXmlToJson(xml, tab);
}

function getMediaArrayXML(murl, callback) {
    operatorLoadVod("antifriz", murl, callback);
}

function getMediaArrayEXTM3U(data) {
    operatorMediaPlaylist("antifriz", data);
}

function getMediaArray(murl, callback) {
    _getParams();
    murl = OttPlayCore.operatorVodRoot("antifriz", murl, key);
    getMediaArrayXML(murl, callback);
}

var cbTarr = ["HLS", "MPEGTS"];

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _getParams();
    popupArray.splice(ind, 0, "Ключ доступа", "Тип потоков: " + cbTarr[mpeg]);
    popupDetail.splice(
        ind,
        0,
        "Ввод ключа доступа для приложений",
        "Выберите тип потоков: HLS или MPEGTS"
    );
    popupActions.splice(ind, 0, doEditKey, doEditType);
}

function doEditKey() {
    editCaption = "Редактирование ключа доступа для приложений";
    editvar = key;
    setEdit = function () {
        if (key == editvar) return;
        if (editvar.length != 8) {
            alert(
                "Для доступа необходимо ввести ключ! (Ключ доступа для приложений - 8 символов)"
            );
            showEditKey([0, 1, 2]);
            return;
        }
        providerSetItem("key", editvar);
        restart();
    };
    showEditKey([0, 1, 2]);
}

function doEditType() {
    if (++mpeg == 2) mpeg = 0;
    providerSetItem("mpeg", mpeg);
    popupArray[popupActions.indexOf(doEditType)] =
        "Тип потоков: " + cbTarr[mpeg];
    popupList(doEditType);
    if (!playType) playChannel(catIndex, primaryIndex);
    else if (playType > 0) playArchive(playType + playTime);
}

_getParams();
