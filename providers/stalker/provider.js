version += " stalker-0219";
p_pref = "stalker";
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

var stalker = {
    data: null,
    mac: "",
    portal: "",
    token: "",
};

function loadStalkerParams() {
    try {
        var d = providerGetItem("stalker_data");
        if (d) stalker = JSON.parse(d);
    } catch (e) {}
    if (!stalker.portal)
        stalker = { data: null, mac: "", portal: "", token: "" };
}

function saveStalkerParams() {
    var d = { data: null, mac: stalker.mac, portal: stalker.portal, token: "" };
    providerSetItem("stalker_data", JSON.stringify(d));
}

function getChannelPicon(e) {
    return chanels[e] ? chanels[e].logo || "" : "";
}
function getChannelUrl(e) {
    return chanels[e] ? chanels[e].url || "" : "";
}

function getArchiveUrl(ch_id, time, time_to) {
    var channel = chanels[ch_id];
    if (!channel) return "";
    return (
        OttPlayCore.providerArchiveUrl(
            "template",
            channel.url || "",
            channel.caso || "",
            channel.ca || "",
            Number(time),
            Number(time_to),
            Date.now() / 1000,
            browserName() === "dune",
            0
        ) || ""
    );
}

function getEPGchanel(s, e) {
    loadStalkerParams();
    if (!(stalker.portal && stalker.mac)) {
        e(s, null);
        return;
    }
    var chId = chanels[s] ? chanels[s].epg : "";
    if (!chId) {
        e(s, null);
        return;
    }
    var client = stalkerCore();
    var apiUrl = client.endpoint();
    var data = client.guideRequest(chId, function () {
        return Date.now() / 1e3;
    });
    $.ajax({
        contentType: "application/json",
        data: JSON.stringify(data),
        dataType: "json",
        timeout: 1e4,
        type: "POST",
        url: apiUrl,
    })
        .done(function (r) {
            var o = client.guide(r);
            e(s, o);
        })
        .fail(function () {
            e(s, null);
        });
}

function stalkerCore() {
    return new OttPlayCore.LegacyStalkerClient(stalker.portal, stalker.mac);
}

function stalkerApiCall(method, params, callback) {
    loadStalkerParams();
    var client = stalkerCore();
    var apiUrl = client.endpoint();
    var data = client.api(method, params || {});
    $.ajax({
        contentType: "application/json",
        data: JSON.stringify(data),
        dataType: "json",
        timeout: 15e3,
        type: "POST",
        url: apiUrl,
    })
        .done(callback)
        .fail(function (e, r, t) {
            console.error("Stalker API error:", method, r, e.status);
            callback(null);
        });
}

function getChanelsArray(callback) {
    loadStalkerParams();
    if (!(stalker.portal && stalker.mac)) {
        editStalkerSettings();
        return;
    }
    if (
        typeof checkProviderUrl === "function" &&
        !checkProviderUrl(stalker.portal)
    ) {
        editStalkerSettings();
        return;
    }
    $(launch_id).append(_("Connecting to Stalker portal..."));
    var client = stalkerCore();
    function next() {
        var request = client.request();
        if (request === null) {
            var catalog = client.catalog(function (name) {
                return xxHash32S(name, true);
            });
            cList = catalog.ids;
            chanels = catalog.channels;
            cats = catalog.groups;
            catsArray = catalog.groupOrder;
            callback();
            return;
        }
        if (request.method === "get_channels")
            $(launch_id).append(_("Loading channels..."));
        stalkerApiCall(request.method, request.params, function (response) {
            var error = client.accept(response);
            if (error) {
                alert(
                    _(
                        error.failure === "LEGACY_CONNECT"
                            ? "Failed to connect to Stalker portal"
                            : "Failed to load channels from Stalker portal"
                    )
                );
                callback();
            } else next();
        });
    }
    next();
}

function duneAddSettings(e) {
    loadStalkerParams();
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("Stalker portal settings"));
    popupActions.splice(e, 1, editStalkerSettings);
    updateStalkerPopup();
}

function updateStalkerPopup() {
    loadStalkerParams();
    var idx = popupActions.indexOf(editStalkerSettings);
    if (idx === -1) return;
    var label = _("Stalker portal settings");
    if (stalker.portal) {
        var hostname = stalker.portal.replace(/^https?:\/\//, "").split("/")[0];
        label += ": " + hostname + " (" + stalker.mac + ")";
    }
    popupArray[idx] = label;
}

function editStalkerSettings() {
    selIndex = 0;
    loadStalkerParams();
    var portal = stalker.portal,
        mac = stalker.mac;
    function buildList() {
        listArray = [
            _("Portal URL") + ": " + (portal || ""),
            _("MAC address") + ": " + (mac || ""),
            "",
            _("Save and load channels"),
        ];
        listDataArray = listArray;
    }
    var i = [
        _("Enter Stalker portal URL (e.g. http://your-portal:8800)"),
        _("Enter MAC address (e.g. 00:1A:2B:3C:4D:5E)"),
        "",
        _("Save settings and load channel list"),
    ];
    buildList();
    getListItem = function (e, r) {
        return "&nbsp;&nbsp;" + e;
    };
    detailListAction = function () {
        listDetail.innerHTML = i[selIndex] || "";
    };
    listKeyHandler = function (e) {
        switch (e) {
            case keys.ENTER:
                switch (selIndex) {
                    case 0:
                        editCaption = _("Enter Stalker portal URL");
                        editvar = portal;
                        setEdit = function () {
                            portal = editvar.trim().replace(/\/+$/, "");
                            buildList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 1:
                        editCaption = _("Enter MAC address");
                        editvar = mac;
                        setEdit = function () {
                            mac = editvar.trim().toUpperCase();
                            buildList();
                            showPage();
                        };
                        showEditKey(keys.ENTER);
                        return true;
                    case 3:
                        stalker.portal = portal;
                        stalker.mac = mac;
                        saveStalkerParams();
                        updateStalkerPopup();
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
    listCaption.innerHTML = _("Stalker Portal Provider");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}
