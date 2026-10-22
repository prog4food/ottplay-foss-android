version += " moidom-0219";
p_pref = "moidom";
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
var _moidom_cfg = { m3u: "", pass: "", server: "", user: "" };
function _moidom_load() {
    try {
        var d = providerGetItem("cfg");
        if (d) _moidom_cfg = JSON.parse(d);
    } catch (e) {}
    if (!(_moidom_cfg.server || _moidom_cfg.m3u))
        _moidom_cfg = { m3u: "", pass: "", server: "", user: "" };
}
function _moidom_save() {
    providerSetItem("cfg", JSON.stringify(_moidom_cfg));
}
function getChannelPicon(e) {
    return chanels[e] ? chanels[e].logo || "" : "";
}
function getChannelUrl(e) {
    return chanels[e] ? chanels[e].url || "" : "";
}
function getEPGchanel(s, e) {
    e(s, null);
}
function getChanelsArray(cb) {
    _moidom_load();
    var action = OttPlayCore.operatorSourceAction(_moidom_cfg);
    if (action === "API") _moidom_xtream(cb);
    else if (action === "PLAYLIST") _moidom_m3u(cb);
    else {
        alert(_("Configure МойДом in Settings -> Provider Settings"));
        cb();
    }
}
function _moidom_m3u(cb) {
    operatorGenericPlaylist(_moidom_cfg, cb);
}
function _moidom_parseM3U(data, cb) {
    operatorParsePlaylist(data, cb);
}
function _moidom_xtream(cb) {
    operatorGenericSession(_moidom_cfg, cb);
}
function duneAddSettings(e) {
    _moidom_load();
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("МойДом settings"));
    popupActions.splice(e, 1, _moidom_edit);
    var idx = popupActions.indexOf(_moidom_edit);
    if (idx > -1) {
        var lbl = _("МойДом settings");
        if (_moidom_cfg.server && _moidom_cfg.user)
            lbl +=
                ": " +
                _moidom_cfg.server.replace(/^https?:\/\//, "").split("/")[0] +
                " (" +
                _moidom_cfg.user +
                ")";
        else if (_moidom_cfg.m3u)
            lbl += ": " + _moidom_cfg.m3u.substr(0, 40) + "...";
        popupArray[idx] = lbl;
    }
}
function _moidom_edit() {
    selIndex = 0;
    _moidom_load();
    var srv = _moidom_cfg.server,
        usr = _moidom_cfg.user,
        pwd = _moidom_cfg.pass,
        m3u = _moidom_cfg.m3u;
    function rebuildSettingsList() {
        listArray = [
            _("Server") + ": " + (srv || ""),
            _("Login") + ": " + (usr || ""),
            _("Password") + ": " + (pwd ? "********" : ""),
            _("M3U") + ": " + (m3u ? m3u.substr(0, 45) : ""),
            "",
            _("Save and load"),
        ];
    }
    var ii = [
        _("API server URL"),
        _("Username"),
        _("Password"),
        _("M3U URL (fallback)"),
        "",
        _("Save & load channels"),
    ];
    rebuildSettingsList();
    getListItem = function (e, r) {
        return "&nbsp;&nbsp;" + e;
    };
    detailListAction = function () {
        listDetail.innerHTML = ii[selIndex] || "";
    };
    listKeyHandler = function (e) {
        switch (e) {
            case keys.ENTER:
                switch (selIndex) {
                    case 0:
                        editCaption = _("Server URL");
                        editvar = srv;
                        setEdit = function () {
                            srv = editvar.trim();
                            rebuildSettingsList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 1:
                        editCaption = _("Username");
                        editvar = usr;
                        setEdit = function () {
                            usr = editvar.trim();
                            rebuildSettingsList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 2:
                        editCaption = _("Password");
                        editvar = pwd;
                        setEdit = function () {
                            pwd = editvar.trim();
                            rebuildSettingsList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 3:
                        editCaption = _("M3U URL");
                        editvar = m3u;
                        setEdit = function () {
                            m3u = editvar.trim();
                            rebuildSettingsList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 5:
                        _moidom_cfg.server = srv;
                        _moidom_cfg.user = usr;
                        _moidom_cfg.pass = pwd;
                        _moidom_cfg.m3u = m3u;
                        _moidom_save();
                        duneAddSettings(0);
                        loadChannels();
                        return true;
                }
                return true;
            case keys.RETURN:
                popupList(popupActions.indexOf(noProvParam) + 1);
                return true;
            default:
                return false;
        }
    };
    listDetail.innerHTML = "";
    listCaption.innerHTML = _("МойДом");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
