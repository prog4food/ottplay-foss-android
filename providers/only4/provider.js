version += " only4-0906";
var token,
    ts_hls,
    provName = "Only4.tv";
p_pref = "o4";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|ХХХ|Adults/i;

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
    token = providerGetItem("token") || "";
    ts_hls = parseInt(providerGetItem("ts_hls"), 10) || 0;
}

function getChannelPicon(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].logo || "" : "";
}

function getChannelUrl(ch_id) {
    return OttPlayCore.operatorLiveUrl("only4", String(ch_id), chanels[ch_id], {
        mode: ts_hls,
    });
}

function getArchiveUrl(ch_id, time, time_to) {
    return (
        OttPlayCore.providerArchiveUrl(
            "only4",
            chanels[ch_id].url,
            "",
            "",
            Number(time),
            Number(time_to),
            Date.now() / 1000,
            browserName() === "dune",
            Number(ts_hls)
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
                "only4",
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
                    entry.channel.channel_name = "??? Нет названия канала";
            });
            if (catalog.malformed) throw new Error("Malformed playlist entry");
            if (!OttPlayCore.operatorCredentialsValid("only4", token, "")) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (ex) {}
                infoBox(
                    "Для доступа необходимо ввести IPTV токен! (10 символов)"
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
            alert(
                "Ошибка обработки списка каналов! Проверьте правильность данных!!"
            );
        }
        callback();
    }

    if (!OttPlayCore.operatorCredentialsValid("only4", token, "")) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox("Для доступа необходимо ввести IPTV токен! (10 символов)");
        callback();
        return;
    }

    if (token)
        loadPlaylist(
            OttPlayCore.operatorProfileUrl("only4", "playlist", {
                token: token,
            }),
            aSuccess,
            callback
        );
    else callback();
}

function getEPGurl(ch_id) {
    return "only4/epg/" + chanels[ch_id].epg;
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
        url: _epgDomen + epg_url + ".json",
    });
}

var shTarr = ["MPEGTS", "HLS(v)", "HLS(a)"];

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    if (isNaN(parseInt(providerGetItem("sShowPikon"), 10)))
        providerSetItem("sShowPikon", 0);
    if (isNaN(parseInt(providerGetItem("ts_hls"), 10)))
        providerSetItem("ts_hls", 1);
    if (typeof delPopup === "function") delPopup(restart);
    _getParams();
    popupArray.splice(ind, 1, "Настройки провайдера " + provName);
    popupDetail.splice(ind, 1, "");
    popupActions.splice(ind, 1, doEditData);
}

function doEditData() {
    selIndex = 0;
    _getParams();
    var r = _(" (after changing, load playlist)"),
        aDetail = [
            "Ввод IPTV токена " + provName + r,
            "Выберите тип потоков:<br>" + shTarr.join(", "),
            "",
            _("Load playlist"),
        ];
    listArray = [
        "IPTV токен",
        "Тип потоков: " + shTarr[ts_hls],
        "",
        (sNoNumbersKeys ? "" : '<div class="btn">8</div> ') +
            _("Load playlist"),
    ];
    listDataArray = listArray;
    getListItem = function (item, i) {
        return "&nbsp;&nbsp;" + item;
    };
    detailListAction = function () {
        listDetail.innerHTML = aDetail[selIndex] || "";
        listPodval.innerHTML =
            btnDiv(keys.RETURN, strRETURN, "Close") +
            ([0, 1].indexOf(selIndex) == -1
                ? ""
                : btnDiv(keys.ENTER, strENTER, "Change value")) +
            (selIndex != 1
                ? ""
                : btnDiv(
                      keys.ENTER,
                      strENTER,
                      "Change value",
                      "&#9664;",
                      "&#9654;"
                  ));
    };
    listKeyHandler = function (code) {
        var a = 1;
        switch (code) {
            case keys.LEFT:
                a = -1;
            case keys.RIGHT:
                if (code != keys.ENTER && selIndex != 1) return false;
            case keys.ENTER:
                switch (selIndex) {
                    case 0:
                        edit_token();
                        return true;
                    case 1:
                        doEditType(a);
                        return true;
                    case 3:
                        loadChannels();
                        return true;
                }
                return true;
            case keys.RETURN:
                popupList(popupActions.indexOf(noProvParam) + 1);
                return true;
            case keys.N8:
                loadChannels();
                return true;
            default:
                return false;
        }
    };
    listDetail.innerHTML = "";
    listCaption.innerHTML = "Настройки провайдера " + provName;
    $("#listPopUp").hide();
    showPage();
}

function edit_token() {
    editCaption = "Редактирование IPTV токена (10 символов)";
    editvar = token;
    setEdit = function () {
        if (editvar && editvar.length != 10) {
            alert("Для доступа необходимо ввести IPTV токен! (10 символов)");
            setTimeout(function () {
                showEditKey([0, 1, 2]);
            });
            return;
        }
        token = editvar;
        providerSetItem("token", token);
        listDataArray = listArray;
        showPage();
    };
    showEditKey([0, 1, 2]);
}

function doEditType(a) {
    ts_hls += a;
    if (ts_hls == shTarr.length) ts_hls = 0;
    if (ts_hls < 0) ts_hls = shTarr.length - 1;
    providerSetItem("ts_hls", ts_hls);
    listArray[1] = "Тип потоков: " + shTarr[ts_hls];
    listDataArray = listArray;
    showPage();
    detailListAction();
    if (!playType) playChannel(catIndex, primaryIndex);
    else if (playType > 0) playArchive(playType + playTime);
}

_getParams();
