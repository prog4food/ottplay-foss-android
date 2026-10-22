version += " edem-0222";
var edkey,
    edlist,
    vpurl,
    edcdn,
    provName = "Edem.tv / iLook.tv";
p_pref = "ed";
parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults|взрослые/i;

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

function _scheme() {
    if (typeof scheme === "string" && scheme) return scheme;
    try {
        if (
            typeof window !== "undefined" &&
            window.location &&
            window.location.protocol &&
            window.location.protocol.indexOf("http") === 0
        ) {
            return window.location.protocol + "//";
        }
    } catch (e) {}
    return "https://";
}

function _getParams() {
    edkey = providerGetItem("key") || "";
    edlist = parseInt(providerGetItem("list"), 10) || 0;
    vpurl = providerGetItem("vpurl") || "";
    edcdn = providerGetItem("edcdn") || "";
}

function getChannelPicon(ch_id) {
    return chanels[ch_id] ? chanels[ch_id].logo || "" : "";
}

function _edcdnHost() {
    return OttPlayCore.operatorEdemHost(edcdn || "");
}

function getChannelUrl(ch_id) {
    _getParams();
    return OttPlayCore.operatorLiveUrl("edem", String(ch_id), chanels[ch_id], {
        host: edcdn || "",
        key: edkey || "",
    });
}

function getArchiveUrl(ch_id, time, time_to) {
    _getParams();
    return (
        OttPlayCore.providerArchiveUrl(
            "utc-now",
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
        operatorLoadPlaylist(url, success, cb, "quiet");
    }

    function aSuccess(data) {
        try {
            cList = [];
            chanels = {};
            cats = {};
            catsArray = [];
            var catalog = OttPlayCore.parseOperatorPlaylist(
                data,
                "edem",
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
                    entry.channel.channel_name = _("??? No channel name");
            });
            if (catalog.malformed) throw new Error("Malformed playlist entry");
            if (!OttPlayCore.operatorCredentialsValid("edem", edkey, "")) {
                doEditData();
                infoBox(
                    "<br>" +
                        _("Access key is required!") +
                        "<br><br>" +
                        btnDiv(keys.ENTER, strENTER, "Close")
                );
            } else if (!_edcdnHost()) {
                doEditData();
                infoBox(
                    "<br>" +
                        _("Channel link is required!") +
                        "<br><br>" +
                        btnDiv(keys.ENTER, strENTER, "Close")
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
            alert(_("Failed to load channel list!"));
        }
        callback();
    }

    var u = OttPlayCore.operatorProfileUrl("edem", "playlist", {
        list: edlist,
        scheme: _scheme(),
    });

    loadPlaylist(u, aSuccess, callback);
}

function getEPGurl(ch_id) {
    if (!(chanels[ch_id] && chanels[ch_id].epg)) return null;
    return (
        (edlist == 1 ? "iptv-e2-soveni" : "edem") + "/epg/" + chanels[ch_id].epg
    );
}

var _epgDomen = null;
function getEPGchanel(ch_id, callback) {
    if (!_epgDomen) _epgDomen = _scheme() + "epg.drm-play.com/";
    var d = null,
        epg_url = getEPGurl(ch_id);
    if (!epg_url) {
        callback(ch_id, d);
        return;
    }
    $.ajax({
        complete: function () {
            callback(ch_id, d);
        },
        dataType: "json",
        success: function (data) {
            if (data && data.epg_data) d = data.epg_data;
        },
        timeout: 10000,
        url: _epgDomen + epg_url + ".json",
    });
}

function item2descr(item, parent) {
    function it(val, title) {
        return val ? "<b>" + _(title) + ": </b>" + val + "<br>" : "";
    }
    function im(val) {
        return val
            ? '<img height="285" width="210" src="' +
                  val +
                  '" style="float: left; margin-right: 5px; margin-bottom: 5px; border-width: 0px; border-style: solid;" onerror="this.width=0;this.height=0;">'
            : "";
    }
    function id(val) {
        return val
            ? "<p><hr><b>" + _("Description") + ": </b>" + val + "</p>"
            : "";
    }
    return (
        '<table><center><b><span style="font-size: 140%;">' +
        item.title +
        "</span></b></center><p>" +
        im(item.img || item.imglr) +
        it(item.year, "Release date") +
        (item.duration
            ? it(Math.round(item.duration) + " " + _("min"), "Duration")
            : "") +
        it(item.agelimit, "Age") +
        id(item.description) +
        "</table>"
    );
}

var __curKey = 0;
function _selV(sh) {
    if (typeof event !== "undefined" && event && event.stopPropagation)
        event.stopPropagation();
    if (__curKey == sh) dialogBoxKeyHandler(keys.ENTER);
    $("#k" + __curKey).css({ "background-color": "", color: "" });
    __curKey = sh;
    $("#k" + __curKey).css({
        "background-color": curColorB,
        color: curColor,
    });
}

function selectVariant(z, variants, callback) {
    var sk = "";
    function setKey(sh) {
        $("#k" + __curKey).css({ "background-color": "", color: "" });
        __curKey = sh;
        if (__curKey < 0) __curKey = variants.length - 1;
        else if (__curKey > variants.length - 1) __curKey = 0;
        $("#k" + __curKey).css({
            "background-color": curColorB,
            color: curColor,
        });
    }
    variants.forEach(function (item, i) {
        sk +=
            '<div id="k' +
            i +
            '" style="display:inline-block;padding:6px 16px;" onclick="_selV(' +
            i +
            ');">' +
            item +
            "</div>&nbsp;&nbsp;";
    });
    $("#dialogbox")
        .html(_("Quality") + ":<br/><br/>" + sk)
        .show();
    setKey(z);
    dialogBoxKeyHandler = function (code) {
        switch (code) {
            case keys.EXIT:
            case keys.RETURN:
                $("#dialogbox").hide();
                callback(-1);
                return;
            case keys.LEFT:
                setKey(__curKey - 1);
                return;
            case keys.RIGHT:
                setKey(__curKey + 1);
                return;
            case keys.UP:
                setKey(1);
                return;
            case keys.DOWN:
                setKey(0);
                return;
            case keys.ENTER:
                $("#dialogbox").hide();
                callback(__curKey);
                return;
        }
    };
}

var parentMedia = null,
    _vpurl,
    _vpkey;
if (typeof sPageSize == "undefined") sPageSize = 30;

function createMedia(val, parent) {
    var item = OttPlayCore.operatorPortalItem(val, parent);
    if (!item) return;
    Object.keys(item).forEach(function (key) {
        val[key] = item[key];
    });
    return OttPlayCore.operatorPortalMedia(val, item2descr(val));
}

function addMedias2(params) {
    var records = mediaRecords;
    var provider = getMediaArray;
    var view = window._mediaLoadState;
    function isCurrent() {
        return (
            records === mediaRecords &&
            provider === getMediaArray &&
            view === window._mediaLoadState
        );
    }
    var requestParams = OttPlayCore.operatorPortalPage(params, selIndex);
    var offset = requestParams.offset;
    $("#dialogbox")
        .html(
            '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                _("Download! Wait ...")
        )
        .show();
    $.ajax({
        complete: function () {
            if (!isCurrent()) return;
            var selected = OttPlayCore.operatorPortalSelection(
                selIndex,
                offset,
                requestParams.limit,
                mediaRecords.map(function (row) {
                    return !!row && typeof row.description === "function";
                })
            );
            if (selected !== selIndex) mediaRecords.length = selected + 1;
            selIndex = selected;
            showPage();
            $("#dialogbox").hide();
        },
        data: JSON.stringify(requestParams),
        success: function (data) {
            if (!isCurrent()) return;
            try {
                var catalog = new OttPlayCore.OperatorPortalCatalogClient(
                        data,
                        true
                    ),
                    row;
                while ((row = catalog.next())) {
                    if (row.kind === "ERROR") alert(row.value);
                    else
                        mediaRecords[offset + row.index] = createMedia(
                            row.value,
                            data
                        );
                }
            } catch (e) {}
        },
        type: "post",
        url: _vpurl,
    });
    return _("Download! Wait ...");
}

function edem_playMedia(med) {
    var imed = medHistory.findIndex(function (val) {
        return val.title == med.title;
    });
    if (imed == 0 && playType == -100000000000) return;

    showPage();
    $("#dialogbox")
        .html(
            '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                _("Download! Wait ...")
        )
        .show();
    var z = 0,
        av = [],
        i = 0,
        variants;
    var params = OttPlayCore.operatorPortalParams(_vpkey, med.request);
    $.ajax({
        async: false,
        data: JSON.stringify(params),
        error: function (jqXHR) {
            alert("Error: " + JSON.stringify(jqXHR));
        },
        success: function (data) {
            if (data !== null)
                if (data.type == "error") alert(data.description);
                else {
                    med.stream_url = data.url;
                    variants = data.variants;
                }
        },
        type: "post",
        url: _vpurl,
    });
    $("#dialogbox").hide();
    var choices = OttPlayCore.operatorPortalVariants(variants, med.stream_url);
    av = choices.keys;
    z = choices.selected;
    function _play() {
        closeList();
        if (imed != -1) medHistory[imed].stream_url = med.stream_url;
        _playMedia(med);
    }
    if (av.length < 2) _play();
    else
        selectVariant(z, av, function (val) {
            if (val == -1) return;
            med.stream_url = variants[av[val]];
            _play();
        });
}

// FOSS: enable VPortal media on all platforms when vpurl is set (not dune-only).
var _getMediaArray = function (murl, callback) {
    if (typeof mediaRecords === "undefined") {
        if (typeof callback === "function") callback();
        return;
    }
    var navigation = OttPlayCore.operatorPortalNavigate(
        murl,
        typeof provName === "undefined" ? "" : provName,
        typeof vpurl === "undefined" ? "" : vpurl,
        _vpkey || "",
        decodeURIComponent
    );
    murl = navigation.node;
    if (navigation.endpoint !== undefined) _vpurl = navigation.endpoint;
    _vpkey = navigation.key;
    if (navigation.action === "FILTERS" || navigation.action === "FILTER") {
        mediaRecords = [];
        (navigation.action === "FILTERS" ? murl.filters : murl.items).forEach(
            function (val) {
                mediaRecords.push(
                    OttPlayCore.operatorPortalFilter(
                        val,
                        navigation.action === "FILTERS"
                    )
                );
            }
        );
        callback();
        return;
    }
    var params = OttPlayCore.operatorPortalParams(
        _vpkey,
        murl.request,
        sPageSize * 10
    );

    $("#dialogbox")
        .html(
            '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                _("Download! Wait ...")
        )
        .show();
    $.ajax({
        complete: function () {
            if (callback.isCurrent && !callback.isCurrent()) return;
            $("#dialogbox").hide();
            callback();
        },
        data: JSON.stringify(params),
        error: function (jqXHR) {
            if (callback.isCurrent && !callback.isCurrent()) return;
            alert("medias : jqXHR:" + JSON.stringify(jqXHR));
        },
        success: function (data) {
            if (callback.isCurrent && !callback.isCurrent()) return;
            try {
                mediaRecords = [];
                var catalog = new OttPlayCore.OperatorPortalCatalogClient(
                        data,
                        false
                    ),
                    row;
                if (catalog.named()) mediaName = murl.mediaName;
                while ((row = catalog.next())) {
                    switch (row.kind) {
                        case "ERROR":
                            alert(row.value);
                            break;
                        case "MEDIA":
                            mediaRecords.push(createMedia(row.value, data));
                            break;
                        case "LAZY":
                            mediaRecords.push({
                                description: function () {
                                    return addMedias2(params);
                                },
                                logo_30x30: "",
                                stream_url: "",
                                title:
                                    row.index +
                                    1 +
                                    " " +
                                    _("Download! Wait ..."),
                            });
                            break;
                        case "SEARCH":
                            mediaRecords.push({
                                description: _("Search"),
                                playlist_url: "search",
                                search_on: 1,
                                title: _("Search"),
                            });
                            break;
                        case "FILTERS":
                            mediaRecords.push({
                                description: _("Filters"),
                                playlist_url: {
                                    a: "filters",
                                    filters: row.value,
                                },
                                title: _("Filters"),
                            });
                            break;
                    }
                }
                return;
            } catch (e) {
                alert(e);
            }
        },
        type: "post",
        url: _vpurl,
    });
};

if (typeof playMedia !== "undefined" || typeof _playMedia !== "undefined") {
    playMedia = edem_playMedia;
}

var edTlist = [
    _("epg.one (Standard)"),
    "soveni",
    _("epg.one (Thematic)"),
    _("epg.one (Ordered)"),
];
var vpAlert =
    _("Enter the VPortal link as shown in the cabinet") +
    ":<br><b>portal::[key:...</b>";

function duneAddSettings(ind) {
    _getParams();
    popupArray.splice(ind, 1, _("Access settings") + " " + provName);
    popupDetail.splice(ind, 1, "");
    popupActions.splice(ind, 1, doEditData);
    getMediaArray = vpurl ? _getMediaArray : null;
}

function doEditData() {
    selIndex = 0;
    _getParams();
    var r = _(" (after changing, load playlist)"),
        cdnLabel = _edcdnHost() || "—",
        aDetail = [
            _("Enter access key for") + " " + provName,
            _(
                "Enter the full CDN host from the cabinet stream URL (e.g. subdomain.cdn-domain.tld), not a bare subdomain"
            ) +
                ":<br><br>" +
                r,
            _("Select playlist template source for EPG and logos") +
                ":<br>" +
                edTlist.join(", ") +
                "<br><br>" +
                r,
            vpAlert,
            "",
            _("Load playlist"),
        ];
    listArray = [
        _("Access key"),
        _("Channel link") + ": " + cdnLabel,
        _("List type") + ": " + edTlist[edlist],
        _("VPortal link"),
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
            (selIndex != 2
                ? ""
                : btnDiv(
                      keys.ENTER,
                      strENTER,
                      "Change value",
                      strLEFT,
                      strRIGHT
                  )) +
            ([0, 1, 3].indexOf(selIndex) == -1
                ? ""
                : btnDiv(keys.ENTER, strENTER, "Change value"));
    };
    listKeyHandler = function (code) {
        var a = 1;
        switch (code) {
            case keys.LEFT:
                a = -1;
            case keys.RIGHT:
                // LEFT/RIGHT rotate list type (row 2); on other rows fall through to ENTER where applicable.
                if (code != keys.ENTER && selIndex != 2) return false;
            case keys.ENTER:
                switch (selIndex) {
                    case 0:
                        edemKey();
                        return true;
                    case 1:
                        edemCdn();
                        return true;
                    case 2:
                        doEditList(a);
                        return true;
                    case 3:
                        vportal();
                        return true;
                    case 5:
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
    listCaption.innerHTML = _("Access settings") + " " + provName;
    $("#listPopUp").hide();
    showPage();
}

function edemKey() {
    editCaption = _("Edit access key");
    editvar = edkey;
    setEdit = function () {
        if (edkey == editvar) return;
        edkey = editvar;
        providerSetItem("key", edkey);
        if (typeof playChannel === "function")
            playChannel(catIndex, primaryIndex);
        showPage();
    };
    showEditKey();
}

function doEditList(a) {
    edlist += a;
    if (edlist == edTlist.length) edlist = 0;
    if (edlist < 0) edlist = edTlist.length - 1;
    providerSetItem("list", edlist);
    listArray[2] = _("List type") + ": " + edTlist[edlist];
    listDataArray = listArray;
    showPage();
}

function edemCdn() {
    editCaption = _("Edit channel link");
    editvar = edcdn || "";
    setEdit = function () {
        var v = (editvar || "").trim();
        if (v) {
            v = v.replace(/^https?:\/\//i, "").split("/")[0];
            if (!/^[A-Za-z0-9][A-Za-z0-9.-]{4,}$/.test(v)) {
                alert(
                    _(
                        "Invalid channel link! Enter the full host as in the cabinet stream URL (e.g. subdomain.cdn-domain.tld)"
                    )
                );
                showEditKey();
                return;
            }
        }
        if (edcdn == v) return;
        edcdn = v;
        providerSetItem("edcdn", edcdn);
        listArray[1] = _("Channel link") + ": " + (_edcdnHost() || "—");
        listDataArray = listArray;
        if (typeof playChannel === "function")
            playChannel(catIndex, primaryIndex);
        showPage();
    };
    showEditKey();
}

function vportal() {
    editCaption = _("Edit VPortal link");
    editvar = vpurl;
    setEdit = function () {
        if (vpurl == editvar) return;
        editvar = editvar.replace("%5B", "[").replace("%5D", "]");
        if (editvar && editvar.indexOf("portal::[key:") != 0) {
            alert(vpAlert);
            showEditKey();
            return;
        }
        vpurl = editvar;
        providerSetItem("vpurl", vpurl);
        getMediaArray = vpurl ? _getMediaArray : null;
        mediaUrls = null;
        mediaNames = [];
        mediaSelects = [0];
    };
    showEditKey();
}

_getParams();
