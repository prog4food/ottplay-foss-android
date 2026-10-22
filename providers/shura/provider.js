version += " shura-0906";
var shserver, shkey, mpeg;
p_pref = "sh";
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
    shkey = providerGetItem("key") || "";
    shserver = providerGetItem("server");
    if (!shserver) shserver = "1";
    mpeg = parseInt(providerGetItem("mpeg"), 10) || 0;
}

function getChannelPicon(ch_id) {
    return "http://s" + shserver + ".tvshka.net:81/picon/" + ch_id + ".png";
}

function getChannelUrl(ch_id) {
    return OttPlayCore.operatorLiveUrl("shura", String(ch_id), chanels[ch_id], {
        key: shkey,
        mode: mpeg,
        server: shserver,
    });
}

function getArchiveUrl(ch_id, time, time_to) {
    return (
        OttPlayCore.providerArchiveUrl(
            "archive",
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

if (typeof catsArray == "undefined") var catsArray = [];

function getChanelsArray(callback) {
    _getParams();

    function aSuccess(data) {
        try {
            var catalog = OttPlayCore.parseOperatorPlaylist(
                data,
                "shura",
                function () {
                    return 0;
                },
                Object.keys(chanels)
            );
            cats = catalog.groups;
            catsArray = catalog.groupOrder;
            catalog.entries.forEach(function (entry) {
                chanels[entry.id].category = entry.channel.category;
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
        }
        if (!OttPlayCore.operatorCredentialsValid("shura", shkey, "")) {
            try {
                popupList(popupActions.indexOf(noProvParam) + 1);
            } catch (ex) {}
            infoBox("Для доступа необходимо ввести ключ!");
        }
        callback();
    }

    function loadCategories() {
        operatorLoadPlaylist(
            OttPlayCore.operatorProfileUrl("shura", "categories", {}),
            aSuccess,
            callback,
            "shura",
            function (jqXHR, textStatus, errorThrown) {
                console.log(
                    "channels : jqXHR:" +
                        JSON.stringify(jqXHR) +
                        "; textStatus: " +
                        textStatus +
                        ", errorThrown: " +
                        errorThrown
                );
                if (!OttPlayCore.operatorCredentialsValid("shura", shkey, "")) {
                    try {
                        popupList(popupActions.indexOf(noProvParam) + 1);
                    } catch (ex) {}
                    infoBox("Для доступа необходимо ввести ключ!");
                }
                callback();
            }
        );
    }

    cList = [];
    chanels = {};
    cats = {};
    catsArray = [];

    $.ajax({
        complete: function () {
            loadCategories();
        },
        data: { type: "jsonp", uid: "shxxxxxxxxxxx" },
        dataType: "jsonp",
        error: function (jqXHR, textStatus, errorThrown) {
            console.log(
                "channels : jqXHR:" +
                    JSON.stringify(jqXHR) +
                    "; textStatus:" +
                    textStatus +
                    " ,errorThrown: " +
                    errorThrown
            );
        },
        success: function (data) {
            var reducer = new OttPlayCore.OperatorCatalogClient("shura");
            try {
                reducer.accept(data, []);
            } finally {
                var catalog = reducer.result();
                cList = catalog.ids;
                chanels = catalog.channels;
            }
        },
        timeout: 10000,
        url: OttPlayCore.operatorProfileUrl("shura", "account", {}),
    });
}

function getEPGchanel(ch_id, callback) {
    operatorLoadGuide(
        "shura",
        ch_id,
        { rec: chanels[ch_id] && chanels[ch_id].rec, server: shserver },
        callback,
        false
    );
}

function getEPGchanelCur(ch_id, callback) {
    operatorLoadGuide(
        "shura",
        ch_id,
        { rec: chanels[ch_id] && chanels[ch_id].rec, server: shserver },
        callback,
        true
    );
}

var cbTarr = ["HLS", "MPEGTS"];

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _getParams();
    popupArray.splice(
        ind,
        0,
        "Шура ТВ: номер сервера",
        "Шура ТВ: Ключ доступа",
        "Шура ТВ: Тип потоков: " + cbTarr[mpeg]
    );
    popupDetail.splice(
        ind,
        0,
        "Ввод номера сервера Шура ТВ",
        "Ввод ключа доступа Шура ТВ",
        "Выберите тип потоков: HLS или MPEGTS"
    );
    popupActions.splice(ind, 0, edit_shserver, edit_shkey, doEditType);
}

function edit_shserver() {
    editCaption =
        "Редактирование номера сервера Шура ТВ<br/>Только 1, 2, 3 или 5 !!!";
    editvar = shserver;
    setEdit = function () {
        shserver = editvar;
        providerSetItem("server", shserver);
        playChannel(catIndex, primaryIndex);
    };
    showEditKey([0]);
}

function edit_shkey() {
    editCaption = "Редактирование ключа доступа Шура ТВ";
    editvar = shkey;
    setEdit = function () {
        if (editvar && editvar.length < 8) {
            alert("Для доступа необходимо ввести ключ!");
            setTimeout(function () {
                showEditKey([0, 1, 2]);
            });
            return;
        }
        shkey = editvar;
        providerSetItem("key", shkey);
        playChannel(catIndex, primaryIndex);
    };
    showEditKey([0, 1, 2]);
}

function doEditType() {
    if (++mpeg == 2) mpeg = 0;
    providerSetItem("mpeg", mpeg);
    popupArray[popupActions.indexOf(doEditType)] =
        "Шура ТВ: Тип потоков: " + cbTarr[mpeg];
    popupList(doEditType);
    if (!playType) playChannel(catIndex, primaryIndex);
    else if (playType > 0) playArchive(playType + playTime);
}

_getParams();
