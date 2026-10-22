version += " ottclub-0220";
var ottwww, ottkey;
p_pref = "";
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
    ottwww = providerGetItem("ottwww") || "";
    ottkey = providerGetItem("ottkey") || "";
}

function getChannelPicon(ch_id) {
    if (!(chanels[ch_id] && chanels[ch_id].img)) return "";
    return "http://" + ottwww + "/images/" + chanels[ch_id].img;
}

function getChannelUrl(ch_id) {
    return OttPlayCore.operatorLiveUrl(
        "ottclub",
        String(ch_id),
        chanels[ch_id],
        { key: ottkey, server: ottwww }
    );
}

function getArchiveUrl(ch_id, time, time_to) {
    return (
        OttPlayCore.providerArchiveUrl(
            "club",
            getChannelUrl(ch_id),
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

$.support.cors = true;

function getChanelsArray(callback) {
    _getParams();
    $.ajax({
        complete: function () {
            if (
                !OttPlayCore.operatorCredentialsValid("ottclub", ottkey, ottwww)
            ) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (e) {}
                infoBox(
                    "Для доступа необходимо ввести ключ и адрес плейлиста!"
                );
            }
            callback();
        },
        dataType: "text",
        error: function (jqXHR, textStatus, errorThrown) {
            console.log(
                "channels : jqXHR:" +
                    JSON.stringify(jqXHR) +
                    "; textStatus: " +
                    textStatus +
                    ", errorThrown: " +
                    errorThrown
            );
            alert(
                "Не удалось загрузить список каналов! Проверьте правильность адреса плейлиста!!"
            );
        },
        success: function (data) {
            try {
                var ids = OttPlayCore.operatorClubIds(data);
                var parsed = JSON.parse(data);
                var reducer = new OttPlayCore.OperatorCatalogClient("ottclub");
                reducer.accept(parsed, ids);
                var catalog = reducer.result();
                cList = catalog.ids;
                chanels = catalog.channels;
                cats = catalog.groups;
                catsArray = catalog.groupOrder;
                Object.keys(catalog.epg).forEach(function (id) {
                    epg[id] = catalog.epg[id];
                });
            } catch (e) {
                cList = [];
                chanels = {};
                console.log(
                    "Exception: name " +
                        e.name +
                        ", message " +
                        e.message +
                        ", typeof " +
                        typeof e
                );
                alert(
                    "Не удалось обработать список каналов! Проверьте правильность адреса плейлиста!!"
                );
            }
        },
        url: "http://" + ottwww + "/api/channel_now",
    });
}

function getEPGchanel(ch_id, callback) {
    var guide = new OttPlayCore.OperatorGuideClient("ottclub"),
        d = guide.result();
    $.ajax({
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            guide.accept(data, "all", 0);
            d = guide.result();
        },
        timeout: 30000,
        url: OttPlayCore.operatorGuideUrl(
            "ottclub",
            String(ch_id),
            { server: ottwww },
            "all"
        ),
    });
}

function duneAddSettings(ind) {
    if (typeof delPopup === "function") delPopup(restart);
    _getParams();
    popupArray.splice(
        ind,
        0,
        "OTTCLUB: Адрес плейлиста",
        "OTTCLUB: Ключ доступа"
    );
    popupDetail.splice(
        ind,
        0,
        "Ввод адреса плейлиста OTTCLUB (После изменения плеер перезапустится!)",
        ""
    );
    popupActions.splice(ind, 0, edit_ottwww, edit_ottkey);
}

function edit_ottwww() {
    editCaption = "Редактирование адреса плейлиста OTTCLUB";
    editvar = ottwww;
    setEdit = function () {
        if (ottwww == editvar) return;
        providerSetItem("ottwww", editvar);
        restart();
    };
    showEditKey([0, 2]);
}

function edit_ottkey() {
    editCaption = "Редактирование ключа доступа OTTCLUB";
    editvar = ottkey;
    setEdit = function () {
        if (ottkey == editvar) return;
        ottkey = editvar;
        providerSetItem("ottkey", ottkey);
        playChannel(catIndex, primaryIndex);
    };
    showEditKey([0, 1]);
}
