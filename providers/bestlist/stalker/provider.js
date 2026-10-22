version += " bestlist_stalker-0219";
p_pref = "bestlist_stalker";
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
var _bestlist_stalker_cfg = { m3u: "", pass: "", server: "", user: "" };
function _bestlist_stalker_load() {
    try {
        var d = providerGetItem("cfg");
        if (d) _bestlist_stalker_cfg = JSON.parse(d);
    } catch (e) {}
    if (!(_bestlist_stalker_cfg.server || _bestlist_stalker_cfg.m3u))
        _bestlist_stalker_cfg = { m3u: "", pass: "", server: "", user: "" };
}
function _bestlist_stalker_save() {
    providerSetItem("cfg", JSON.stringify(_bestlist_stalker_cfg));
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
    _bestlist_stalker_load();
    if (
        _bestlist_stalker_cfg.server &&
        _bestlist_stalker_cfg.user &&
        _bestlist_stalker_cfg.pass
    )
        _bestlist_stalker_xtream(cb);
    else if (_bestlist_stalker_cfg.m3u) _bestlist_stalker_m3u(cb);
    else {
        alert(
            _(
                "Configure BEST LiST IPTV [Stalker] in Settings -> Provider Settings"
            )
        );
        cb();
    }
}
function _bestlist_stalker_m3u(cb) {
    $(launch_id).append(_("Loading M3U..."));
    $.ajax({
        error: function () {
            $.ajax({
                data: { url: "@" + _bestlist_stalker_cfg.m3u },
                dataType: "text",
                error: function () {
                    alert(_("Failed to load!"));
                    cb();
                },
                method: "post",
                success: function (d) {
                    _bestlist_stalker_parseM3U(d, cb);
                },
                timeout: 15e3,
                url: host + "/m3u/cp.php",
            });
        },
        success: function (d) {
            _bestlist_stalker_parseM3U(d, cb);
        },
        timeout: 15e3,
        url: _bestlist_stalker_cfg.m3u,
    });
}
function _bestlist_stalker_parseM3U(data, cb) {
    cList = [];
    chanels = {};
    cats = {};
    catsArray = [];
    try {
        var catalog = OttPlayCore.parseProviderPlaylist(
            data,
            "generic",
            function (url) {
                return xxHash32S(url, true);
            },
            0
        );
        cList = catalog.ids;
        chanels = catalog.channels;
        cats = catalog.groups;
        catsArray = catalog.groupOrder;
    } catch (error) {
        console.log(error);
    }
    cb();
}
function bestlistStalkerCore() {
    return OttPlayCore.legacyXtreamClient(
        _bestlist_stalker_cfg.server,
        _bestlist_stalker_cfg.user,
        _bestlist_stalker_cfg.pass,
        encodeURIComponent
    );
}

function _bestlist_stalker_xtream(cb) {
    $(launch_id).append(_("Loading from API..."));
    var client = bestlistStalkerCore();
    $.ajax({
        dataType: "json",
        timeout: 15e3,
        type: "GET",
        url: client.request(),
    })
        .done(function (r) {
            cList = [];
            chanels = {};
            cats = {};
            catsArray = [];
            if (client.accept(r)) {
                _bestlist_stalker_cfg.m3u = client.fallbackPlaylist(false);
                _bestlist_stalker_m3u(cb);
                return;
            }
            var catalog = client.legacyCatalog(function (name) {
                return xxHash32S(name, true);
            });
            cList = catalog.ids;
            chanels = catalog.channels;
            cats = catalog.groups;
            catsArray = catalog.groupOrder;
            cb();
        })
        .fail(function () {
            _bestlist_stalker_cfg.m3u = client.fallbackPlaylist(true);
            _bestlist_stalker_m3u(cb);
        });
}

function duneAddSettings(e) {
    _bestlist_stalker_load();
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("BEST LiST IPTV [Stalker] settings"));
    popupActions.splice(e, 1, _bestlist_stalker_edit);
    var idx = popupActions.indexOf(_bestlist_stalker_edit);
    if (idx > -1) {
        var lbl = _("BEST LiST IPTV [Stalker] settings");
        if (_bestlist_stalker_cfg.server && _bestlist_stalker_cfg.user)
            lbl +=
                ": " +
                _bestlist_stalker_cfg.server
                    .replace(/^https?:\/\//, "")
                    .split("/")[0] +
                " (" +
                _bestlist_stalker_cfg.user +
                ")";
        else if (_bestlist_stalker_cfg.m3u)
            lbl += ": " + _bestlist_stalker_cfg.m3u.substr(0, 40) + "...";
        popupArray[idx] = lbl;
    }
}
function _bestlist_stalker_edit() {
    selIndex = 0;
    _bestlist_stalker_load();
    var srv = _bestlist_stalker_cfg.server,
        usr = _bestlist_stalker_cfg.user,
        pwd = _bestlist_stalker_cfg.pass,
        m3u = _bestlist_stalker_cfg.m3u;
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
                        _bestlist_stalker_cfg.server = srv;
                        _bestlist_stalker_cfg.user = usr;
                        _bestlist_stalker_cfg.pass = pwd;
                        _bestlist_stalker_cfg.m3u = m3u;
                        _bestlist_stalker_save();
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
    listCaption.innerHTML = _("BEST LiST IPTV [Stalker]");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
