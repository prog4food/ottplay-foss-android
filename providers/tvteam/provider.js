version += " tvteam-0906";
var tvteamwww;
p_pref = "tvteam";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults/i;

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
    tvteamwww = providerGetItem("www") || "https://tv.team/pl/11/";
}

function _normalizePlaylistUrl(url) {
    return OttPlayCore.operatorTvteamPlaylist(url || "");
}

function _captureTokenFromUrl() {
    var url = "";
    try {
        url = OttPlayCore.operatorCapturedTvteamPlaylist(
            window.location.href,
            typeof browserName === "function" && browserName() === "dune"
        );
    } catch (e) {}
    if (url) {
        tvteamwww = url;
        providerSetItem("www", tvteamwww);
        window.location.href = window.location.href.split("?")[0];
    }
}

function getProviderParams() {
    _captureTokenFromUrl();
    _getParams();
    try {
        $("#tvteamwww").val(tvteamwww);
    } catch (e) {}
    if (!tvteamwww) alert("Для доступа необходимо ввести адрес плейлиста!");
    return tvteamwww;
}

function setProviderParams() {
    providerSetItem("www", decodeURIComponent($("#tvteamwww").val().trim()));
    var wwwchanged = tvteamwww != providerGetItem("www");
    _getParams();
    if (!OttPlayCore.operatorCredentialsValid("tvteam", tvteamwww, ""))
        alert("Для доступа необходимо ввести адрес плейлиста!");
    return wwwchanged;
}

function getChannelPicon(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].logo || "" : "";
}

function getChannelUrl(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].url || "" : "";
}

function getArchiveUrl(ch_id, time, time_to) {
    return (
        OttPlayCore.providerArchiveUrl(
            "auto-utc-now",
            chanels[ch_id].url,
            "",
            "",
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
    _captureTokenFromUrl();
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
                "tvteam",
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
            if (
                !OttPlayCore.operatorCredentialsValid("tvteam", tvteamwww, "")
            ) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (ex) {}
                infoBox("Для доступа необходимо ввести адрес плейлиста!");
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

    if (!OttPlayCore.operatorCredentialsValid("tvteam", tvteamwww, "")) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox("Для доступа необходимо ввести адрес плейлиста!");
        callback();
        return;
    }

    loadPlaylist(tvteamwww, aSuccess, callback);
}

function getEPGchanel(ch_id, callback) {
    var d = null;
    $.ajax({
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            if (data !== null) d = data.epg_data;
        },
        timeout: 10000,
        // REF also lists http://epg.drm-play.com/tvteam/epg/{id}.json
        url: "http://tvteam.eu/" + ch_id + ".json",
    });
}

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _getParams();
    popupArray.splice(ind, 1, "tv.team : Адрес плейлиста");
    popupDetail.splice(
        ind,
        1,
        'Ввод адреса плейлиста tv.team</b>Тип плейлиста: <b>OTTPlayer</b><br/><br/>Вы можете не вводить окончание адреса плейлиста "/playlist.m3u8" - оно будет добавлено автоматически'
    );
    popupActions.splice(ind, 1, tvteamUrl);
}

function tvteamUrl() {
    editCaption = "Редактирование адреса плейлиста tv.team";
    editvar = tvteamwww;
    setEdit = function () {
        tvteamwww = _normalizePlaylistUrl(editvar);
        providerSetItem("www", tvteamwww);
    };
    showEditKey();
}

_getParams();
