version += " sharatv-0906";
var login, pass;
p_pref = "shtv";
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
    login = providerGetItem("login") || "";
    pass = providerGetItem("pass") || "";
}

function getProviderParams() {
    _getParams();
    try {
        $("#login").val(login);
        $("#pass").val(pass);
    } catch (e) {}
    if (!OttPlayCore.operatorCredentialsValid("shara-tv", login, pass))
        alert("Для доступа необходимо ввести Логин и пароль!");
    return OttPlayCore.operatorCredentialsValid("shara-tv", login, pass);
}

function setProviderParams() {
    providerSetItem("login", decodeURIComponent($("#login").val().trim()));
    var changed = login != providerGetItem("login");
    providerSetItem("pass", decodeURIComponent($("#pass").val().trim()));
    changed = changed || pass != providerGetItem("pass");
    _getParams();
    if (!OttPlayCore.operatorCredentialsValid("shara-tv", login, pass))
        alert("Для доступа необходимо ввести Логин и пароль!");
    return changed;
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
                "shara-tv",
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
            if (
                !OttPlayCore.operatorCredentialsValid("shara-tv", login, pass)
            ) {
                try {
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } catch (ex) {}
                infoBox("Для доступа необходимо ввести Логин и пароль!");
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

    if (!OttPlayCore.operatorCredentialsValid("shara-tv", login, pass)) {
        try {
            popupList(popupActions.indexOf(noProvParam) + 1);
        } catch (ex) {}
        infoBox(
            !login || !pass
                ? "Логин или пароль отсутсвуют!"
                : "Для доступа необходимо ввести Логин и пароль!"
        );
        callback();
        return;
    }

    loadPlaylist(
        OttPlayCore.operatorProfileUrl("shara-tv", "playlist", {
            login: login,
            password: pass,
        }),
        aSuccess,
        callback
    );
}

function getEPGchanel(ch_id, callback) {
    var d = null;
    if (!(chanels[ch_id] && chanels[ch_id].epg)) {
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
        url:
            "http://epg.drm-play.com/shara-tv/epg/" +
            chanels[ch_id].epg +
            ".json",
    });
}

var provName = "shara-tv";

function duneAddSettings(ind) {
    if (isNaN(parseInt(providerGetItem("sShowArchive"), 10)))
        providerSetItem("sShowArchive", 1);
    _getParams();
    popupArray.splice(ind, 0, provName + ": Логин", provName + ": Пароль");
    popupDetail.splice(
        ind,
        0,
        "Ввод логина " +
            provName +
            " (после изменения нужно перезапустить плеер)",
        "Ввод пароля " +
            provName +
            " (после изменения нужно перезапустить плеер)"
    );
    popupActions.splice(ind, 0, edit_login, edit_pass);
}

function edit_login() {
    editCaption = "Редактирование логина " + provName;
    editvar = login;
    setEdit = function () {
        if (editvar.length != 8) {
            alert("Для доступа необходимо ввести Логин (8 символов)!");
            showEditKey([0, 2]);
            return;
        }
        login = editvar;
        providerSetItem("login", login);
    };
    showEditKey([0, 2]);
}

function edit_pass() {
    editCaption = "Редактирование пароля " + provName;
    editvar = pass;
    setEdit = function () {
        if (editvar.length != 8) {
            alert("Для доступа необходимо ввести Пароль (8 символов)!");
            showEditKey([0, 2]);
            return;
        }
        pass = editvar;
        providerSetItem("pass", pass);
    };
    showEditKey([0, 2]);
}

_getParams();
