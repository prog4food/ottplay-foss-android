version += " 1ott-0906";
var __id,
    __pin,
    _pName = "1OTT.NET",
    url_srv = "http://list.1ott.net";
p_pref = "1ott";
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
    __id = providerGetItem("id") || "";
    __pin = providerGetItem("pin") || "";
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
            "utc",
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
                "1ott",
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
            if (!OttPlayCore.operatorCredentialsValid("1ott", __id, __pin)) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (ex) {}
                infoBox("Для доступа необходимо ввести ID и PIN!");
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

    if (!OttPlayCore.operatorCredentialsValid("1ott", __id, __pin)) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox("Для доступа необходимо ввести ID и PIN!");
        callback();
        return;
    }

    loadPlaylist(
        OttPlayCore.operatorProfileUrl("1ott", "account", {
            base: url_srv,
            id: __id,
            pin: __pin,
        }),
        function (data) {
            try {
                loadPlaylist(
                    OttPlayCore.operatorProfileUrl("1ott", "playlist", {
                        base: url_srv,
                        token: JSON.parse(data).token,
                    }),
                    aSuccess,
                    callback
                );
            } catch (e) {
                alert(_("Failed to load channel list!"));
                callback();
            }
        },
        callback
    );
}

function getEPGurl(ch_id) {
    return "propg.net/epg/" + chanels[ch_id].epg;
}

_epgDomen = "http://epg.drm-play.com/";

function getEPGchanel(ch_id, callback) {
    var d = null,
        epg_url = getEPGurl(ch_id);
    if (!epg_url || !(chanels[ch_id] && chanels[ch_id].epg)) {
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

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    if (typeof delPopup === "function") delPopup(restart);
    _getParams();
    popupArray.splice(ind, 1, _("Settings") + " " + _pName);
    popupDetail.splice(ind, 1, "");
    popupActions.splice(ind, 1, __Settings);
}

function __Settings() {
    var r = _(" (after changing, restart player)");
    listArray = [
        {
            action: edit_login,
            desc: _("Редактирование ID") + r,
            name: _("ID"),
        },
        {
            action: edit_pass,
            desc: _("Редактирование PIN") + r,
            name: _("PIN"),
        },
        {},
        {
            action: restart,
            desc: _("Restart player"),
            name:
                (sNoNumbersKeys ? "" : '<div class="btn">8</div> ') +
                _("Restart player"),
        },
    ];
    selIndex = 0;
    getListItem = function (item, i) {
        return "&nbsp;&nbsp;" + (item.name || "");
    };
    detailListAction = function () {
        listDetail.innerHTML = _(
            listArray[selIndex].desc || listArray[selIndex].name || ""
        );
    };
    listKeyHandler = function (code) {
        switch (code) {
            case keys.RETURN:
                popupList(popupActions.indexOf(noProvParam) + 1);
                return true;
            case keys.ENTER:
                if (listArray[selIndex].action) listArray[selIndex].action();
                return true;
            case keys.N8:
                restart();
                return true;
            default:
                return false;
        }
    };
    listCaption.innerHTML = _("Settings") + " " + _pName;
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}

function edit_login() {
    editCaption = _("Редактирование ID") + " " + _pName;
    editvar = __id;
    setEdit = function () {
        __id = editvar;
        providerSetItem("id", __id);
    };
    showEditKey([0]);
}

function edit_pass() {
    editCaption = _("Редактирование PIN") + " " + _pName;
    editvar = __pin;
    setEdit = function () {
        __pin = editvar;
        providerSetItem("pin", __pin);
    };
    showEditKey([0]);
}

_getParams();
