version += " itv-0906";
var itvkey,
    itvmpeg,
    wwwapi = "http://api.01cdn.wf/";
p_pref = "itv";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults|Взрослый/i;

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
    itvkey = providerGetItem("key") || "";
    itvmpeg = parseInt(providerGetItem("mpeg"), 10) || 0;
}

function getProviderParams() {
    _getParams();
    try {
        $("#itvkey").val(itvkey);
    } catch (e) {}
    if (!OttPlayCore.operatorCredentialsValid("itv", itvkey, ""))
        alert(
            "Для доступа необходимо ввести ключ! (Ключ для плеера 10-12 символов)"
        );
    return itvkey;
}

function setProviderParams() {
    providerSetItem("key", decodeURIComponent($("#itvkey").val().trim()));
    var changed = itvkey != providerGetItem("key");
    _getParams();
    if (!OttPlayCore.operatorCredentialsValid("itv", itvkey, ""))
        alert(
            "Для доступа необходимо ввести ключ! (Ключ для плеера 10-12 символов)"
        );
    return changed;
}

function getChannelPicon(ch_id) {
    return wwwapi + "icon/" + ch_id;
}

function getChannelUrl(ch_id) {
    return OttPlayCore.operatorLiveUrl("itv", String(ch_id), chanels[ch_id], {
        mode: itvmpeg,
    });
}

function getArchiveUrl(ch_id, time, time_to) {
    var channel = chanels[ch_id];
    return (
        OttPlayCore.providerArchiveUrl(
            "itv",
            "http://" + channel.server_cdn + "/" + ch_id + "/",
            "?token=" + channel.token,
            "",
            Number(time),
            Number(time_to),
            Date.now() / 1000,
            browserName() === "dune",
            Number(itvmpeg)
        ) || ""
    );
}

if (typeof catsArray == "undefined") var catsArray = [];

function getChanelsArray(callback) {
    _getParams();
    cList = [];
    chanels = {};
    cats = {};
    catsArray = [];

    if (!OttPlayCore.operatorCredentialsValid("itv", itvkey, "")) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox(
            "Для доступа необходимо ввести ключ! (Ключ для плеера 10-12 символов)"
        );
        callback();
        return;
    }

    $.ajax({
        complete: function () {
            callback();
        },
        dataType: "json",
        error: function (jqXHR, textStatus, errorThrown) {
            console.log(
                "channels : jqXHR:" +
                    JSON.stringify(jqXHR) +
                    "; textStatus: " +
                    textStatus +
                    ", errorThrown: " +
                    errorThrown
            );
            alert(_("Failed to load channel list!"));
        },
        success: function (data) {
            var reducer = new OttPlayCore.OperatorCatalogClient("itv");
            try {
                reducer.accept(data, []);
            } finally {
                var catalog = reducer.result();
                cList = catalog.ids;
                chanels = catalog.channels;
                cats = catalog.groups;
                catsArray = catalog.groupOrder;
            }
        },
        timeout: 30000,
        url: wwwapi + "data/" + itvkey,
    });
}

if (typeof sNextCount == "undefined") sNextCount = -1;

function _getEPGchanel(ch_id, callback, all) {
    var guide = new OttPlayCore.OperatorGuideClient("itv"),
        d = guide.result();
    $.ajax({
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            try {
                guide.accept(data, "all", 0);
            } catch (e) {
            } finally {
                d = guide.result();
            }
        },
        timeout: 10000,
        url: OttPlayCore.operatorGuideUrl(
            "itv",
            String(ch_id),
            { base: wwwapi, next: sNextCount },
            all ? "all" : "current"
        ),
    });
}

function getEPGchanel(ch_id, callback) {
    _getEPGchanel(ch_id, callback, true);
}

function getEPGchanelCur(ch_id, callback) {
    _getEPGchanel(ch_id, callback, false);
}

var itvTarr = ["HLS(a)", "MPEGTS", "HLS(v)"];

function duneAddSettings(ind) {
    if (
        isNaN(parseInt(providerGetItem("mpeg"), 10)) &&
        navigator.userAgent.indexOf("Tizen") != -1
    )
        providerSetItem("mpeg", 2);
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _getParams();
    popupArray.splice(
        ind,
        0,
        "Ключ доступа iTV.Live",
        "Тип потоков: " + itvTarr[itvmpeg],
        "Информация о подписке"
    );
    popupDetail.splice(
        ind,
        0,
        "Ввод ключа доступа iTV.Live (Ключ для плеера)",
        "Выберите тип потоков:<br>" + itvTarr.join(", "),
        ""
    );
    popupActions.splice(ind, 0, doEditKey, doEditType, doUserInfo);
}

function doEditKey() {
    editCaption = "Редактирование ключа доступа iTV.Live (Ключ для плеера)";
    editvar = itvkey;
    setEdit = function () {
        if (itvkey == editvar) return;
        if (editvar.length < 10 || editvar.length > 12) {
            alert(
                "Для доступа необходимо ввести ключ! (Ключ для плеера 10-12 символов)"
            );
            showEditKey([0, 1]);
            return;
        }
        providerSetItem("key", editvar);
        restart();
    };
    showEditKey([0, 1]);
}

function doEditType() {
    if (++itvmpeg == itvTarr.length) itvmpeg = 0;
    providerSetItem("mpeg", itvmpeg);
    popupArray[popupActions.indexOf(doEditType)] =
        "Тип потоков: " + itvTarr[itvmpeg];
    try {
        listArray[selIndex].name = "Тип потоков: " + itvTarr[itvmpeg];
    } catch (e) {}
    showPage();
    if (!playType) playChannel(catIndex, primaryIndex);
    else if (playType > 0) playArchive(playType + playTime);
}

function doUserInfo() {
    aboutKeyHandler = function () {
        $("#listAbout").hide();
        return true;
    };
    $("#listAbout").html("Загрузка. Подождите...").show();
    $.ajax({
        dataType: "json",
        error: function (jqXHR, textStatus, errorThrown) {
            $("#listAbout").html(
                "get_user_info failed!<br/><br/>jqXHR:" +
                    JSON.stringify(jqXHR) +
                    "<br/>textStatus: " +
                    textStatus +
                    "<br/>errorThrown: " +
                    errorThrown
            );
        },
        success: function (data) {
            if (data !== null) {
                var pi = [];
                try {
                    data.package_info.forEach(function (val) {
                        pi.push(val.name);
                    });
                } catch (e) {}
                var ui = data.user_info || {};
                $("#listAbout").html(
                    "Информация о подписке:<br/>" +
                        "<br/>Логин: " +
                        (ui.login || "") +
                        "<br/>Баланс,$: " +
                        (ui.cash || "") +
                        "<br/>Система: " +
                        ["", "Предоплата", "Постоплата"][ui.pay_system || 0] +
                        "<br/>Пакеты: " +
                        pi.join(", ")
                );
            }
        },
        timeout: 30000,
        url: wwwapi + "data/" + itvkey,
    });
}

_getParams();
