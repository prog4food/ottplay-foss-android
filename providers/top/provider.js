version += " top-0219";
p_pref = "top";
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
var _top_cfg = { m3u: "", pass: "", server: "", user: "" };
function _top_load() {
    try {
        var d = providerGetItem("cfg");
        if (d) _top_cfg = JSON.parse(d);
    } catch (e) {}
    if (!(_top_cfg.server || _top_cfg.m3u))
        _top_cfg = { m3u: "", pass: "", server: "", user: "" };
}
function _top_save() {
    providerSetItem("cfg", JSON.stringify(_top_cfg));
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
    _top_load();
    var action = OttPlayCore.operatorSourceAction(_top_cfg);
    if (action === "API") _top_xtream(cb);
    else if (action === "PLAYLIST") _top_m3u(cb);
    else {
        alert(_("Configure Top-Tv in Settings -> Provider Settings"));
        cb();
    }
}
function _top_m3u(cb) {
    operatorGenericPlaylist(_top_cfg, cb);
}
function _top_parseM3U(data, cb) {
    operatorParsePlaylist(data, cb);
}
function _top_xtream(cb) {
    operatorGenericSession(_top_cfg, cb);
}
function duneAddSettings(e) {
    _top_load();
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("Top-Tv settings"));
    popupActions.splice(e, 1, _top_edit);
    var idx = popupActions.indexOf(_top_edit);
    if (idx > -1) {
        var lbl = _("Top-Tv settings");
        if (_top_cfg.server && _top_cfg.user)
            lbl +=
                ": " +
                _top_cfg.server.replace(/^https?:\/\//, "").split("/")[0] +
                " (" +
                _top_cfg.user +
                ")";
        else if (_top_cfg.m3u) lbl += ": " + _top_cfg.m3u.substr(0, 40) + "...";
        popupArray[idx] = lbl;
    }
}
function _top_edit() {
    selIndex = 0;
    _top_load();
    var srv = _top_cfg.server,
        usr = _top_cfg.user,
        pwd = _top_cfg.pass,
        m3u = _top_cfg.m3u;
    function rebuildSettingsList() {
        listArray = [
            _("Server") + ": " + (srv || ""),
            _("Login") + ": " + (usr || ""),
            _("Password") + ": " + (pwd ? "********" : ""),
            _("M3U") + ": " + (m3u ? m3u.substr(0, 45) : ""),
            "",
            _("Save and load"),
        ];
        listDataArray = listArray;
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
                        _top_cfg.server = srv;
                        _top_cfg.user = usr;
                        _top_cfg.pass = pwd;
                        _top_cfg.m3u = m3u;
                        _top_save();
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
    listCaption.innerHTML = _("Top-Tv");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
