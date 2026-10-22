version += " raduga-0219";
p_pref = "raduga";
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
var _raduga_cfg = { m3u: "", pass: "", server: "", user: "" };
function _raduga_load() {
    try {
        var d = providerGetItem("cfg");
        if (d) _raduga_cfg = JSON.parse(d);
    } catch (e) {}
    if (!(_raduga_cfg.server || _raduga_cfg.m3u))
        _raduga_cfg = { m3u: "", pass: "", server: "", user: "" };
}
function _raduga_save() {
    providerSetItem("cfg", JSON.stringify(_raduga_cfg));
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
    _raduga_load();
    var action = OttPlayCore.operatorSourceAction(_raduga_cfg);
    if (action === "API") _raduga_xtream(cb);
    else if (action === "PLAYLIST") _raduga_m3u(cb);
    else {
        alert(_("Configure Радуга in Settings -> Provider Settings"));
        cb();
    }
}
function _raduga_m3u(cb) {
    operatorGenericPlaylist(_raduga_cfg, cb);
}
function _raduga_parseM3U(data, cb) {
    operatorParsePlaylist(data, cb);
}
function _raduga_xtream(cb) {
    operatorGenericSession(_raduga_cfg, cb);
}
function duneAddSettings(e) {
    _raduga_load();
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("Радуга settings"));
    popupActions.splice(e, 1, _raduga_edit);
    var idx = popupActions.indexOf(_raduga_edit);
    if (idx > -1) {
        var lbl = _("Радуга settings");
        if (_raduga_cfg.server && _raduga_cfg.user)
            lbl +=
                ": " +
                _raduga_cfg.server.replace(/^https?:\/\//, "").split("/")[0] +
                " (" +
                _raduga_cfg.user +
                ")";
        else if (_raduga_cfg.m3u)
            lbl += ": " + _raduga_cfg.m3u.substr(0, 40) + "...";
        popupArray[idx] = lbl;
    }
}
function _raduga_edit() {
    selIndex = 0;
    _raduga_load();
    var srv = _raduga_cfg.server,
        usr = _raduga_cfg.user,
        pwd = _raduga_cfg.pass,
        m3u = _raduga_cfg.m3u;
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
                        _raduga_cfg.server = srv;
                        _raduga_cfg.user = usr;
                        _raduga_cfg.pass = pwd;
                        _raduga_cfg.m3u = m3u;
                        _raduga_save();
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
    listCaption.innerHTML = _("Радуга");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
