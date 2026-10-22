var m3u_defaults = { epg_server: "http://ottp.eu.org" };
// Local FOSS: always point EPG requests to local server
if (typeof host === "string" && host.indexOf("ottp.eu.org") === -1) {
    m3u_defaults.epg_server = host;
} else if (!client_can.crossxhr && window.location.host !== "ottp.eu.org") {
    m3u_defaults.epg_server = "http://" + window.location.host;
}
var epg_sources = {};

function postMatch(a, e, r, t) {
    $.ajax({
        contentType: "text/plain",
        data: e,
        dataType: "text",
        timeout: 120000,
        type: "POST",
        url: a,
    })
        .done(function (e) {
            if (!e) return;
            if (e) r(e);
        })
        .fail(function (e, r, t) {
            var i =
                "!!! ERROR LOADING: " +
                a.split("/").pop() +
                " - " +
                r +
                "/" +
                e.status +
                "/" +
                t;
            console.error(i);
        })
        .always(function () {
            t();
        });
}

// Additional metadata is native-only; the browser companion keeps its original protocol.
function nativeMatchMetadata() {
    if (!(window.Capacitor || window.__TAURI__)) return {};
    var entries = {};
    cList.forEach(function (id) {
        var ch = chanels[id];
        if (!ch) return;
        entries[String(id)] = {
            name: ch.channel_name || "",
            tvg_id: ch.epg || "",
            tvg_name: ch.tn || "",
            xmltv_urls: ch.xmltv_urls || [],
        };
    });
    return { native_channels: entries };
}

function nativeXmltvSources(value, defaults, aliases) {
    var result = [];
    (value || "").split(",").forEach(function (source) {
        source = source.trim();
        if (source.charAt(0) === "#") {
            var index = Number(source.slice(1));
            source = index > 0 ? defaults[index - 1] : aliases[source.slice(1)];
        }
        if (typeof source !== "string") return;
        if (source.indexOf("//") === 0) source = "https:" + source;
        if (/^https?:\/\//i.test(source) && result.indexOf(source) === -1)
            result.push(source);
    });
    return result;
}

function getEpgList(e, r, t) {
    if (!(cList.length && r)) {
        t();
        return;
    }
    var requestList = cList;
    $(launch_id).append(_("epgs..."));
    var i = e.epg_server === void 0 ? m3u_defaults.epg_server : e.epg_server;
    var a = nativeMatchMetadata();
    var n = JSON.stringify(a) + "\n\t\n";
    if (e.raw.length !== 0) {
        n += e.raw.join("\n");
    }
    n += "\n\t\n" + r;
    postMatch(
        i + "/m3u/match-channels",
        n,
        function (e) {
            // loadChannels replaces cList while retaining the shared channel map.
            if (cList !== requestList) return;
            var r = e.split("\n\t\n");
            if (r.length != 3) return;
            var t, i, a, n;
            n = r[2].split("\n");
            for (t = 0; t < n.length; t++) {
                a = n[t].split("~");
                if (a.length == 2) {
                    epg_sources[a[0]] = a[1] + "epg/";
                    if (!client_can.crossxhr) {
                        epg_sources[a[0]] = epg_sources[a[0]].replace(
                            "//epg.ottp.eu.org/",
                            "//" + window.location.host + "/e/"
                        );
                    }
                }
            }
            n = r[1].split("\n");
            for (t = 0; t < n.length; t++) {
                a = n[t].split("~");
                if (a.length !== 3) continue;
                i = chanels[a[0]];
                if (i === undefined) continue;
                i.epg_src = a[1];
                i.epg_url = a[2];
            }
        },
        t
    );
}

function getLogoList(e, r, t) {
    if (!(cList.length && r)) {
        t();
        return;
    }
    $(launch_id).append(_("logos..."));
    var i = e.ico_server === undefined ? m3u_defaults.epg_server : e.ico_server;
    var a = nativeMatchMetadata();
    var n = JSON.stringify(a) + "\n\t\n";
    if (e.raw.length !== 0) {
        n += e.raw.join("\n");
    }
    n += "\n\t\n" + r;
    postMatch(
        i + "/m3u/match-logos",
        n,
        function (e) {
            var r = e.split("\n\t\n");
            if (r.length != 2) return;
            var t, i, a, n;
            n = r[1].split("\n");
            for (t = 0; t < n.length; t++) {
                a = n[t].split("~");
                if (a.length !== 2) continue;
                i = chanels[a[0]];
                if (i === undefined) continue;
                i.logo = a[1];
            }
        },
        t
    );
}

function getEPGurl(e) {
    var r = chanels[e];
    if (r !== undefined && r.epg_src && r.epg_url) {
        var t = epg_sources[r.epg_src];
        if (t !== undefined) {
            t += r.epg_url + ".json";
            return t;
        }
    }
    return null;
}

function getEPGchanel(s, e) {
    var o = null,
        r = getEPGurl(s);
    if (!r) {
        e(s, o);
        return;
    }
    // Pass configured archive/history hours so companion lookback honors
    // M3U rechours / catchup-days (not the hardcoded ±48h-only window).
    try {
        var _rec =
            chanels[s] && chanels[s].rec != null ? Number(chanels[s].rec) : 0;
        if (_rec > 0) {
            r +=
                (r.indexOf("?") >= 0 ? "&" : "?") + "hours=" + Math.floor(_rec);
        }
    } catch (_h) {}
    $.ajax({
        dataType: "json",
        timeout: 1e4,
        type: "GET",
        url: r,
    })
        .done(function (e) {
            var r = e;
            if (r !== null && r.epg_data !== undefined) {
                o = r.epg_data;
                if (chanels[s].ts !== undefined) {
                    var t = chanels[s].ts;
                    var i = void 0;
                    var a = o.length;
                    for (var n = 0; n < a; n++) {
                        i = o[n];
                        if (i.time > 0 && i.time_to > 0) {
                            i.time += t;
                            i.time_to += t;
                        }
                    }
                }
            }
        })
        .fail(function (e, r, t) {
            console.log(
                "NOTICE: Loaded epg.json with status=" +
                    r +
                    "/" +
                    e.status +
                    "/" +
                    t
            );
        })
        .always(function () {
            e(s, o);
        });
}

function provEpgLoader(e, r) {
    var requestList = cList;
    if (r !== "")
        getEpgList(e, r, function () {
            if (cList !== requestList) return;
            // Rows may have requested EPG before matching supplied their URLs.
            // Retry those misses without discarding valid full-schedule caches.
            var now = Date.now() / 1000;
            var e = curList[primaryIndex];
            for (var i = 0; i < requestList.length; i++) {
                var id = requestList[i];
                var ch = chanels[id];
                if (ch && ch.time_request > now && getEPGurl(id)) {
                    ch.time_request = 0;
                    if (
                        id !== e &&
                        typeof getCurProgData === "function" &&
                        typeof updateChanelList === "function"
                    )
                        getCurProgData(id, updateChanelList);
                }
            }
            if (e !== undefined) {
                chanels[e].time_request = 0;
                updateChanelInfo(e);
            }
        });
}

version += " m3u-0218";
var m3uArr,
    _number = 0,
    m3uCap = 15;
p_pref = "m3u";
parental =
    /XXX|\u0412\u0437\u0440\u043e\u0441\u043b\u044b\u0435|\u0414\u043b\u044f \u0432\u0437\u0440\u043e\u0441\u043b\u044b\u0445|\u042d\u0440\u043e\u0442\u0438\u043a\u0430|18\+|Adults/i;

function keyNames4(e) {
    if (pdsa.indexOf(e) != -1) e += m3uArr.active || "";
    return e;
}
if (typeof stbGetItem === "function") {
    providerGetItem = function (e) {
        return stbGetItem(p_pref + keyNames4(e));
    };
    providerSetItem = function (e, r) {
        stbSetItem(p_pref + keyNames4(e), r);
    };
    providerDelItem = function (e) {
        return stbDelItem(p_pref + keyNames4(e));
    };
    providerHasItem = function (e) {
        return stbGetItem(p_pref + keyNames4(e)) !== null;
    };
    providerHasItemValue = function (e) {
        var v = stbGetItem(p_pref + keyNames4(e));
        return v !== null && v !== "";
    };
} else {
    providerGetItem = function (e) {
        return localStorage.getItem(p_pref + keyNames4(e));
    };
    providerSetItem = function (e, r) {
        localStorage.setItem(p_pref + keyNames4(e), r);
    };
    providerDelItem = function (e) {
        var s =
            typeof window !== "undefined" && window.ottpStorage
                ? window.ottpStorage
                : ottpStorage;
        return s.del(p_pref + keyNames4(e));
    };
    providerHasItem = function (e) {
        var s =
            typeof window !== "undefined" && window.ottpStorage
                ? window.ottpStorage
                : ottpStorage;
        return s.has(p_pref + keyNames4(e));
    };
    providerHasItemValue = function (e) {
        var s =
            typeof window !== "undefined" && window.ottpStorage
                ? window.ottpStorage
                : ottpStorage;
        return s.hasValue(p_pref + keyNames4(e));
    };
}

function loadM3Uparams() {
    m3uArr = providerGetItem("m3uArr");
    if (!m3uArr) m3uArr = { active: 0, M3Us: [] };
    else
        try {
            m3uArr = JSON.parse(m3uArr);
        } catch (e) {
            m3uArr = { active: 0, M3Us: [] };
        }
    for (var e = m3uArr.M3Us.length; e < m3uCap; e++)
        m3uArr.M3Us[e] = { rechours: 0, www: "" };
    if (browserName() == "dune")
        try {
            var r = window.location.href.split("?")[1].split("&");
            r.forEach(function (e) {
                var r = e.split("=");
                if (r[0] == "n") {
                    _number = Number.parseInt(r[1]);
                    throw {};
                }
            });
        } catch (e) {}
    if (_number > 0 && _number <= m3uCap) m3uArr.active = _number - 1;
}

function getProviderParams() {
    loadM3Uparams();
    for (var e = 0; e < m3uCap; e++) {
        $("#www" + e).val(m3uArr.M3Us[e].www);
        $("#rechours" + e).val(m3uArr.M3Us[e].rechours);
    }
    $("input:radio[name=odin]")
        .filter("[value=" + m3uArr.active + "]")
        .prop("checked", true);
    return m3uArr.M3Us[m3uArr.active].www;
}

function setProviderParams() {
    for (var e = 0; e < m3uCap; e++) {
        m3uArr.M3Us[e].www = decodeURIComponent(
            $("#www" + e)
                .val()
                .trim()
        );
        m3uArr.M3Us[e].rechours = $("#rechours" + e)
            .val()
            .trim();
    }
    m3uArr.active = $("input[name=odin]:checked").val();
    var r = JSON.stringify(m3uArr) != providerGetItem("m3uArr");
    providerSetItem("m3uArr", JSON.stringify(m3uArr));
    loadM3Uparams();
    if (m3uArr.M3Us[m3uArr.active].www.length < 8)
        alert(
            "\u0414\u043b\u044f \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e \u0432\u0432\u0435\u0441\u0442\u0438 \u0430\u0434\u0440\u0435\u0441 \u043f\u043b\u0435\u0439\u043b\u0438\u0441\u0442\u0430!"
        );
    return r;
}

function getChannelPicon(e) {
    return chanels[e] ? chanels[e].logo || "" : "";
}

function getChannelUrl(e) {
    return chanels[e].url || "";
}

function getArchiveUrl(ch_id, time, time_to) {
    var channel = chanels[ch_id];
    if (!channel) return "";
    return (
        OttPlayCore.providerArchiveUrl(
            "m3u",
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

if (typeof catsArray == "undefined") var catsArray = [];

function addChan2cat(e, r) {
    if (!(e && r)) return;
    if (!cats[e]) {
        catsArray.push(e);
        cats[e] = [];
    }
    cats[e].push(r);
}

function getChanelsArray(a) {
    function O(e, r) {
        return OttPlayCore.legacyPlaylistAttribute(e, r);
    }

    function e(e, i, a) {
        if (typeof launch_id == "undefined") launch_id = "#launch";
        if (!e) {
            a();
            return;
        }
        var n = e;
        if (typeof stbInterceptRequest === "function") {
            stbInterceptRequest(e);
            e +=
                (e.indexOf("?") == -1 ? "?" : "&") +
                "url=" +
                encodeURIComponent(e);
        }
        $.ajax({
            error: function (e, r, t) {
                $(launch_id).append(
                    _(
                        "Playlist is not loading directly...Loading via server..."
                    )
                );
                $.ajax({
                    data: { url: "@" + n },
                    dataType: "text",
                    error: function (e, r, t) {
                        console.log(
                            "channels : jqXHR:" +
                                JSON.stringify(e) +
                                "; textStatus: " +
                                r +
                                ", errorThrown: " +
                                t
                        );
                        alert(_("Failed to load channel list!"));
                        a();
                    },
                    method: "post",
                    success: i,
                    timeout: 15e3,
                    url: host + "/m3u/cp.php",
                });
            },
            success: i,
            timeout: 5e3,
            url: e,
        });
    }

    function r(e) {
        epg_sources = {};
        var r = function (t, e) {
            if (!e) {
                return;
            }
            e.split(",").map(function (e) {
                var r = e.trim().split("::");
                if (r.length !== 2) {
                    return;
                }
                if (r[0] === "!epg-server") {
                    t.epg_server = r[1];
                }
                if (r[0] === "!ico-server") {
                    t.ico_server = r[1];
                } else if (r[0].charCodeAt(0) === 61) {
                    epg_sources[r[0]] = r[1];
                } else {
                    t.foss[r[0]] = r[1];
                }
            });
        };
        var w = function (n, e, s) {
            if (!e) {
                return;
            }
            if (e.charCodeAt(0) === 61 && epg_sources[e] !== void 0) {
                n.splice(0);
                n.push(e);
                return;
            }
            e.split(",").map(function (e) {
                var r;
                var t = e.trim();
                if (t.length < 2) {
                    return;
                }
                if (s !== void 0) {
                    if (t.charCodeAt(0) === 35) {
                        var i = Number.parseInt(t.slice(1), 10);
                        var a = isNaN(i) ? s.foss[t.slice(1)] : s.raw[i - 1];
                        if (a === void 0) {
                            return;
                        }
                        r = xxHash32Si(StripHttp(a));
                    } else {
                        r = xxHash32Si(StripHttp(t));
                    }
                } else {
                    r = StripHttp(t);
                }
                if (n.indexOf(r) === -1) {
                    n.push(r);
                }
            });
        };
        var E = "",
            N = "",
            b = { foss: {}, raw: [] };
        try {
            var catalog = OttPlayCore.parseProviderPlaylist(
                    e,
                    "m3u",
                    function (url) {
                        return murmurhash3_32_gc(url, 10);
                    },
                    Number.parseInt(m3uArr.M3Us[m3uArr.active].rechours)
                ),
                i = catalog.header;
            cList = catalog.ids;
            chanels = catalog.channels;
            cats = catalog.groups;
            catsArray = catalog.groupOrder;
            r(b, O(i, "foss-tvg"));
            if (window.Capacitor || window.__TAURI__) {
                b.native_xmltv_urls = nativeXmltvSources(
                    [O(i, "url-tvg"), O(i, "x-tvg-url")]
                        .filter(Boolean)
                        .join(","),
                    [],
                    b.foss
                );
            }
            w(b.raw, O(i, "url-tvg"));
            w(b.raw, O(i, "x-tvg-url"));
            catalog.entries.forEach(function (entry) {
                var i = [entry.raw],
                    n = entry.epgId,
                    s = entry.epgName,
                    l = entry.logo,
                    p = [],
                    d = entry.generatedName
                        ? _("??? No channel name")
                        : entry.name,
                    m = entry.titleHashInput
                        ? xxHash32S(entry.titleHashInput, true)
                        : 0,
                    y = entry.id,
                    x;
                chanels[y].channel_name = d;
                w(p, O(entry.raw, "tvg-source"), b);
                w(p, O(entry.raw, "url-tvg"), b);
                if (window.Capacitor || window.__TAURI__) {
                    var customSources = [
                        O(i[0], "tvg-source"),
                        O(i[0], "url-tvg"),
                    ]
                        .filter(Boolean)
                        .join(",");
                    chanels[y].xmltv_urls = customSources
                        ? nativeXmltvSources(
                              customSources,
                              b.native_xmltv_urls || [],
                              b.foss
                          )
                        : (b.native_xmltv_urls || []).slice();
                    chanels[y].epg_external = !!(
                        b.epg_server && b.epg_server !== m3u_defaults.epg_server
                    );
                }
                if (
                    p.length === 1 &&
                    n &&
                    typeof p[0] === "string" &&
                    p[0].charCodeAt(0) === 61
                ) {
                    chanels[y].epg_src = p[0];
                    chanels[y].epg_url = xxHash32Si(n);
                } else if (m != 0 || n || s) {
                    x = [y, xxHash32Si(n), xxHash32Si(s), m].join("-");
                    if (p.length !== 0) {
                        x += "~" + p.join("-");
                    }
                    E +=
                        x +
                        "~" +
                        encodeURIComponent(entry.titleHashInput || d) +
                        "\n";
                }
                if (!l && (m != 0 || n || s)) {
                    if (x === void 0) {
                        x = [y, xxHash32Si(n), xxHash32Si(s), m].join("-");
                        if (p.length !== 0 && p[0].charCodeAt(0) !== 61) {
                            x += "~" + p.join("-");
                        }
                    }
                    N +=
                        x +
                        "~" +
                        encodeURIComponent(entry.titleHashInput || d) +
                        "\n";
                }
            });
        } catch (e) {
            console.error(e);
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
        a();
        provEpgLoader(b, E);
        if (N !== "")
            getLogoList(b, N, function () {
                updateChanelInfo(curList[primaryIndex]);
            });
    }
    var t = m3uArr.M3Us[m3uArr.active].www;
    if (/^portal:/i.test((t || "").trim())) {
        alert(_("Enter playlist URL"));
        a();
        return;
    }
    if (typeof checkProviderUrl === "function" && !checkProviderUrl(t)) {
        a();
        return;
    }
    if (!t) {
        try {
            $(launch_id).hide();
            if (typeof clearBootHide === "function") clearBootHide();
        } catch (e) {}
        doEditListData(m3uArr.active);
        return;
    }
    if (typeof readFile === "function" && t && t[0] === "/") r(readFile(t));
    else e(t, r, a);
}

function _m3u2popup() {
    var e = Number.parseInt(m3uArr.active),
        r = m3uArr.M3Us[e];
    popupArray[popupActions.indexOf(doEditM3Ua)] =
        _("Select playlist") +
        ": " +
        (e + 1 + " - " + (r.name || m3uMediaDisplay(r.www)));
}

function m3uMediaDisplay(value) {
    return String(value || "").replace(
        /(portal::(?:\[|%5b)key:)[\s\S]*?(\]|%5d)/i,
        "$1***$2"
    );
}

function m3uReopenEditor(initKeys) {
    // The browser input editor tears down after setEdit returns. Reopen after it.
    setTimeout(function () {
        showEditKey(initKeys);
    }, 0);
}

// Only legacy Dune catalogs remain attached to M3U slots.
function m3uUpdateMedia() {
    var active = m3uArr.active;
    var source = m3uArr.M3Us[active].medUrl || "";
    var previous = window.providerMediaClient;
    if (previous) previous.dispose();
    window.providerMediaClient = null;
    if (typeof cancelMediaLoad === "function") cancelMediaLoad();
    mediaUrls = null;
    mediaNames = [];
    mediaSelects = [0];
    mediaRecords = [];
    mediaRecordsPar = null;
    getMediaArray = null;
    if (typeof _playMedia === "function") playMedia = _playMedia;
    // Legacy portal links are inert; VPortal has its own provider profile.
    if (!source || /^portal:/i.test(source.trim())) return;
    if (browserName() === "dune") {
        // Preserve existing non-portal Dune catalogs.
        getMediaArray = _getMediaArray;
    }
}

function duneAddSettings(e) {
    loadM3Uparams();
    if (_number > 0 && _number <= m3uCap) {
        doEditM3Ua = doEditListData;
    }
    popupArray.splice(e, 1, "");
    popupDetail.splice(e, 1, _("Select playlist"));
    popupActions.splice(e, 1, doEditM3Ua);
    _m3u2popup();
    m3uUpdateMedia();
}

function selectAndRestart(e) {
    var r = m3uArr.active;
    m3uArr.active = e;
    providerSetItem("m3uArr", JSON.stringify(m3uArr));
    m3uArr.active = r;
    loadPlaylist();
}

function loadPlaylist() {
    loadM3Uparams();
    _m3u2popup();
    m3uUpdateMedia();
    loadChannels();
}
var doEditM3Ua = function (e) {
    if (typeof e === "undefined") e = m3uArr.active;
    selIndex = e;
    listArray = m3uArr.M3Us;
    listDataArray = listArray;
    getListItem = function (e, r) {
        return (
            "&nbsp;&nbsp;" +
            (sNoNumbersKeys || r >= 6
                ? r + 1 + ":&nbsp;"
                : '<div class="btn">' + (r + 1) + "</div>&nbsp;") +
            (e.name || m3uMediaDisplay(e.www) || "—")
        );
    };
    detailListAction = function () {
        var e = m3uArr.M3Us[selIndex];
        listDetail.innerHTML =
            _("Playlist Name") +
            ': <span " style="color:' +
            curColor +
            ';">' +
            (e.name || "") +
            "</span><br/>" +
            _("Playlist URL") +
            ':<br/><span " style="color:' +
            curColor +
            ';">' +
            m3uMediaDisplay(e.www) +
            "</span><br/>" +
            _("Archive hours") +
            ': <span " style="color:' +
            curColor +
            ';">' +
            (e.rechours || 0) +
            "</span>";
        listPodval.innerHTML =
            btnDiv(keys.RETURN, strRETURN, "Close") +
            btnDiv(
                keys.ENTER,
                strENTER,
                m3uArr.active == selIndex || !m3uArr.M3Us[selIndex].www
                    ? "Edit"
                    : "Load"
            );
    };
    listKeyHandler = function (e) {
        switch (e) {
            case keys.RETURN:
                _m3u2popup();
                popupList(popupActions.indexOf(noProvParam) + 1);
                return true;
            case keys.N1:
            case keys.N2:
            case keys.N3:
            case keys.N4:
            case keys.N5:
            case keys.N6:
                selIndex = e - 49;
            case keys.ENTER:
                if (m3uArr.active == selIndex || !m3uArr.M3Us[selIndex].www)
                    doEditListData(selIndex);
                else selectAndRestart(selIndex);
                return true;
            default:
                return false;
        }
    };
    listDetail.innerHTML = "";
    listCaption.innerHTML = _("Select playlist");
    listPodval.innerHTML = "";
    $("#listPopUp").hide();
    showPage();
};

function doEditListData(r) {
    function n() {
        var e = 0;
        listArray[e++] = _("Playlist Name") + ": " + (s.name || "");
        listArray[e++] = _("Playlist URL") + ": " + m3uMediaDisplay(s.www);
        if (typeof readFile === "function") {
            var r = "";
            if (s.www && s.www[0] === "/") {
                var t = s.www.split("/");
                r = t[t.length - 1];
            }
            listArray[e++] = _("Playlist file") + ": " + r + strNew;
        }
        listArray[e++] = _("Archive hours") + ": " + (s.rechours || 0);
        listDataArray = listArray;
    }

    function t(e, r, t, i, a) {
        editCaption = _(e);
        editvar = (s[r] || "").toString();
        setEdit = function () {
            if (s[r] == editvar.trim()) return;
            if (r === "www" && /^portal:/i.test(editvar.trim())) {
                alert(_("Enter playlist URL"));
                m3uReopenEditor(t);
                return;
            }
            if (a)
                pdsa.forEach(function (e) {
                    providerDelItem(e);
                });
            s[r] = i ? Number.parseInt(editvar) || 0 : editvar;
            providerSetItem("m3uArr", JSON.stringify(m3uArr));
            n();
            m3uUpdateMedia();
            showPage();
        };
        showEditKey(t);
    }
    if (typeof r === "undefined") r = m3uArr.active;
    var s = m3uArr.M3Us[r];
    selIndex = 0;
    var e = _(" (after changing, load playlist)"),
        i = [
            _("Enter playlist Name"),
            _("Enter playlist URL") + e,
            _("Enter playlist archive hours") + e,
            "",
            _("Load playlist"),
        ],
        a = 2,
        l = 4,
        u = 1e3;
    listArray = ["", "", "", "", _("Load playlist")];
    if (typeof readFile == "function") {
        listArray.splice(2, 0, "");
        i.splice(2, 0, _("Select playlist file") + e);
        a = 3;
        l = 5;
        u = 2;
    }
    n();
    getListItem = function (e, r) {
        return "&nbsp;&nbsp;" + e;
    };
    detailListAction = function () {
        listDetail.innerHTML = i[selIndex];
    };
    listKeyHandler = function (e) {
        switch (e) {
            case keys.ENTER:
                switch (selIndex) {
                    case 0:
                        t("Enter playlist Name", "name");
                        return true;
                    case 1:
                        t(
                            "Enter playlist URL",
                            "www",
                            null,
                            false,
                            m3uArr.active == r
                        );
                        return true;
                    case u:
                        if (typeof showFileDialog !== "function") {
                            alert(
                                _(
                                    "File selection is not supported on this device"
                                )
                            );
                            return true;
                        }
                        editvar = (s["www"] || "").toString();
                        setEdit = function () {
                            s.www = editvar;
                            providerSetItem("m3uArr", JSON.stringify(m3uArr));
                            n();
                            showPage();
                        };
                        showFileDialog(editvar, "m3u,m3u8");
                        return true;
                    case a:
                        t(
                            "Enter playlist archive hours",
                            "rechours",
                            [0],
                            true
                        );
                        return true;
                    case l:
                        if (_number > 0 && _number <= m3uCap) loadPlaylist();
                        else selectAndRestart(r);
                        return true;
                }
                return true;
            case keys.RETURN:
                if (_number > 0 && _number <= m3uCap) {
                    _m3u2popup();
                    popupList(popupActions.indexOf(noProvParam) + 1);
                } else doEditM3Ua(r);
                return true;
            default:
                return false;
        }
    };
    listDetail.innerHTML = "";
    listCaption.innerHTML = _("Edit playlist data");
    listPodval.innerHTML = btnDiv(keys.RETURN, strRETURN, "Close");
    $("#listPopUp").hide();
    showPage();
}

function Text2Dom(e) {
    var r = new DOMParser();
    return r.parseFromString(e, "text/xml");
}

function fXMLCh2Json(e, r) {
    var t = { t: e.tagName };
    var i = true;
    for (var a = e.firstElementChild; a; a = a.nextElementSibling) {
        if (r.indexOf(a.tagName) !== -1) {
            t[a.tagName] = a.textContent;
            if (i === true) i = false;
        }
    }
    if (!t.title)
        t.title =
            "<\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f>";
    return i === true ? null : t;
}

function fXML_to_JSON(e, r) {
    var t = ["channels", "menu"];
    var i = ["playlist_name", "title", "next_page_url", "prev_page_url"];
    var a = ["channel", "menu"];
    var n = [
        "search_on",
        "adult",
        "title",
        "logo_30x30",
        "description",
        "playlist_url",
        "stream_url",
    ];
    if (e.childNodes.length === 0) return false;
    var s = true;
    var o;
    for (o = e.firstChild; o; o = o.nextSibling) {
        if (o.nodeType === 1) break;
    }
    if (!o) return false;
    e = o;
    if (e.tagName == "items") e = e.firstElementChild;
    var l;
    if (r.channels === undefined) r.channels = [];

    function u(e) {
        if (a.indexOf(e.tagName) !== -1) {
            l = fXMLCh2Json(e, n);
            if (l !== null) {
                if (s === true) s = false;
                r.channels.push(l);
            }
        }
    }
    for (o = e; o; o = o.nextElementSibling) {
        if (t.indexOf(o.tagName) !== -1) {
            for (var c = o.firstElementChild; c; c = c.nextElementSibling) {
                u(c);
            }
        }
        u(o);
        if (i.indexOf(o.tagName) !== -1) {
            r[o.tagName] = o.textContent;
        }
    }
    return !s;
}

function getMediaArrayXML(e, r) {
    function isCurrent() {
        return !r.isCurrent || r.isCurrent();
    }
    mediaUrls[mediaUrls.length - 1] = e;
    if (e === "") {
        r();
        return;
    }
    $("#dialogbox")
        .html(
            '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                _("Download! Wait ...")
        )
        .show();
    if (typeof box_mac !== "undefined" && box_mac)
        e +=
            (e.indexOf("?") == -1 ? "?" : "&") +
            "box_client=ott-foss&box_mac=" +
            box_mac;
    $.ajax({
        complete: function () {
            if (!isCurrent()) return;
            $("#dialogbox").hide();
            r();
        },
        dataType: "text",
        error: function (e, r, t) {
            if (!isCurrent()) return;
            alert("Error: " + e.status);
        },
        success: function (e, r, t) {
            if (!isCurrent()) return;
            var i = e.slice(0, 16);
            if (i.length < 7) {
                alert("Error: Bad response length!");
                return;
            }
            var a = "";
            if (i[0] === "<") a = "xml";
            else if (i.indexOf("#EXTM3U") !== -1) a = "m3u";
            else if (i[0] === "{") a = "json";
            else {
                alert("Bad data header: " + i + "!");
                return;
            }
            var n = {};
            try {
                if (a === "xml") {
                    var s = Text2Dom(e);
                    var o = s.querySelector("parsererror");
                    if (o) {
                        var l = document.createElement("textarea");
                        e = e.replace(/&[a-z0-9]+;/gi, function (e) {
                            l.innerHTML = e;
                            return (
                                "&#" +
                                l.textContent.charCodeAt(0).toString(10) +
                                ";"
                            );
                        });
                        s = Text2Dom(e);
                        o = s.querySelector("parsererror");
                        if (o) {
                            e = e.replace(
                                /(title|description)>([^<>\n]+)</gi,
                                function (e, r, t) {
                                    return r + "><![CDATA[" + t + "]]><";
                                }
                            );
                            s = Text2Dom(e);
                            o = s.querySelector("parsererror");
                            if (o) {
                                alert("Error: Cannot parse fXML!");
                                console.error(
                                    "Cannot parse fXML: " +
                                        e +
                                        "\n\n" +
                                        o.innerHTML
                                );
                                return;
                            }
                        }
                    }
                    if (fXML_to_JSON(s, n) === false) {
                        alert("Error: Bad fXML!");
                        console.error("Bad fXML: " + e);
                        return;
                    }
                    mediaRecords = n.channels;
                } else if (a === "m3u") {
                    getMediaArrayEXTM3U(e);
                    return;
                } else if (a === "json") {
                    n = JSON.parse(e);
                    var u = ["menu", "channels"];
                    mediaRecords = [];
                    var c = void 0,
                        f = void 0;
                    for (var p in n) {
                        if (n.hasOwnProperty(p) && u.indexOf(p) !== -1) {
                            c = n[p];
                            if (Array.isArray(c)) {
                                f = p;
                                if (f === "channels") f = "channel";
                                for (var d = 0; d < c.length; d++) {
                                    c[d].t = f;
                                    mediaRecords.push(c[d]);
                                }
                            }
                        }
                    }
                }
                mediaName = n.playlist_name || n.title || mediaName || "?";
                if (n.next_page_url)
                    mediaRecords.push({
                        description: "...",
                        logo_30x30: "",
                        playlist_url: n.next_page_url,
                        title: "...",
                    });
            } catch (e) {
                console.error(e);
            }
        },
        timeout: 6e4,
        url: e,
    });
}

function getMediaArrayEXTM3U(e) {
    function u(e, r) {
        return (
            "<table><h2><center>" +
            e +
            "</center></h2>" +
            (r
                ? '<img id="detal" height="285" src="' +
                  r +
                  '" style="float: left; margin-right: 5px; margin-bottom: 5px; border-width: 0px; border-style: solid;" width="210">'
                : "") +
            "</table>"
        );
    }
    try {
        mediaName = mediaName || "?";
        mediaRecords = [];
        OttPlayCore.parsePlaylistMedia(e).forEach(function (entry) {
            var name = entry.generatedName ? "??? Нет названия" : entry.name;
            mediaRecords.push({
                description: u(name, entry.logo),
                logo_30x30: entry.logo,
                stream_url: entry.url,
                title: name,
            });
        });
    } catch (e) {
        alert("Error M3U !!!");
    }
}
if (browserName() == "dune") {
    var _getMediaArray = function (e, r) {
        if (e === "") e = m3uArr.M3Us[m3uArr.active].medUrl || "";
        if (/^portal:/i.test(e.trim())) {
            mediaRecords = [];
            r();
            return;
        }
        getMediaArrayXML(e, r);
    };
    var box_mac = stb.getMacAddress().replace(/:/g, "");
}
