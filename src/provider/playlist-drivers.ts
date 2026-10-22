interface OwnedPlaylistPorts extends ProviderDriverPorts {
    decodeXml(text: string, profile?: string): any;
    deviceMac(): string;
    murmur(value: string, seed: number): number;
    scheme(): string;
    storageFor(prefix: string): DriverStorage;
    userAgent(): string;
}
interface OwnedPlaylistDriver extends ProviderDriver {
    cancelMedia(): void;
    media(
        url: string,
        name: string,
        callback: (result: MediaCatalogResult) => void
    ): void;
    mediaUrl(url: string): string;
    storageKey(key: string): string;
    updates(
        callback: (catalog: DriverCatalog, kind: string) => void
    ): () => void;
}

// OTTPLAY_FULL_ONLY_BEGIN
function createOwnedPlaylistDriver(
    id: string,
    ports: OwnedPlaylistPorts,
    owner: DriverLifetime,
    helpers: any
): OwnedPlaylistDriver {
    if (id !== "antifriz" && id !== "kb-team")
        throw new Error("Unsupported playlist driver: " + id);
    var disposed = false,
        revision = 0;
    var catalogs = ports.createLifetime(),
        panels = ports.createLifetime();
    var catalog = helpers.emptyCatalog();
    var listeners: Array<(catalog: DriverCatalog, kind: string) => void> = [];
    var mac =
        id === "kb-team"
            ? String(ports.deviceMac() || "")
                  .replace(/:/g, "")
                  .toLowerCase()
            : "";
    function readSlot(): number {
        var value = Number(ports.storage.get("v_list") || 0);
        return isFinite(value) &&
            value >= 0 &&
            value < 3 &&
            Math.floor(value) === value
            ? value
            : 0;
    }
    var slot = id === "kb-team" ? readSlot() : 0;
    function active(): boolean {
        return !disposed && owner.active();
    }
    var transport = helpers.transport(ports, owner, active);
    var media = helpers.media(ports, owner, helpers);
    function credentials(): ProviderCredentials {
        return {
            mode: parseInt(ports.storage.get("mpeg") || "0", 10) || 0,
            password: "",
            playlist: String(slot),
            server: "",
            username: id === "kb-team" ? mac : ports.storage.get("key") || "",
        };
    }
    function identity(): string {
        return id === "kb-team" ? mac + ":" + slot : credentials().username;
    }
    function available(scope: DriverLifetime, source: string): boolean {
        return active() && scope.active() && identity() === source;
    }
    function notify(scope: DriverLifetime, source: string, kind: string): void {
        listeners.slice().forEach(function (listener) {
            if (available(scope, source))
                listener(helpers.snapshot(catalog), kind);
        });
    }
    function enrich(scope: DriverLifetime, source: string): void {
        if (!catalog.ids.length || !available(scope, source)) return;
        var guide: any = Object.create(null),
            logos: any = Object.create(null);
        catalog.ids.forEach(function (channelId: any) {
            var row = catalog.channels[channelId],
                title = row.tn || row.channel_name;
            guide[channelId] = row.utvg
                ? row.epg
                    ? { e: row.epg, n: title, u: row.utvg }
                    : { n: row.channel_name, u: row.utvg }
                : { n: title };
            if (!row.logo)
                logos[channelId] = row.utvg
                    ? row.channel_name + "|" + row.utvg
                    : title;
        });
        function request(
            kind: string,
            values: any,
            endpoint: string,
            field: string
        ): void {
            if (!available(scope, source)) return;
            ports.progress(kind === "guide" ? "epgs..." : "logos...");
            if (!available(scope, source)) return;
            transport.send(
                scope,
                {
                    data: { list: JSON.stringify(values) },
                    method: "post",
                    timeout: 120000,
                    url: ports.scheme() + "epg.drm-play.com/m3u/" + endpoint,
                },
                function (data: any) {
                    if (!available(scope, source)) return;
                    if (data && typeof data === "object")
                        catalog.ids.forEach(function (channelId: any) {
                            if (
                                Object.prototype.hasOwnProperty.call(
                                    data,
                                    channelId
                                ) &&
                                data[channelId]
                            )
                                catalog.channels[channelId][field] =
                                    data[channelId];
                        });
                    notify(scope, source, kind);
                },
                function () {
                    if (available(scope, source)) notify(scope, source, kind);
                }
            );
        }
        request("guide", guide, "gelist.php", "epg_url");
        if (Object.keys(logos).length)
            request("logo", logos, "geicons.php", "logo");
    }
    function guide(
        channelId: string | number,
        callback: (value: any) => void,
        current: boolean
    ): void {
        if (!active()) return;
        var row = catalog.channels[channelId],
            scope = catalogs.current();
        var identifier =
            row && (id === "antifriz" ? row.epg_id || row.epg : row.epg_url);
        if (!scope || !identifier) {
            callback(id === "antifriz" ? [] : null);
            return;
        }
        var source = identity();
        var options: any = {
            dataType: "json",
            timeout: id === "antifriz" ? 30000 : 10000,
            url:
                id === "antifriz"
                    ? "http://protected-api.com/epg/" +
                      (current
                          ? "current/" +
                            identifier +
                            "?num=" +
                            (ports.guideNext() + 1)
                          : identifier + "?date=")
                    : ports.scheme() +
                      "epg.drm-play.com/" +
                      encodeURIComponent(identifier) +
                      ".json",
        };
        if (id === "antifriz") options.cache = false;
        transport.send(
            scope,
            options,
            function (data: any) {
                if (!available(scope, source)) return;
                var result: any = null;
                if (id === "antifriz")
                    result = Array.isArray(data)
                        ? data
                              .filter(function (row) {
                                  return row && typeof row === "object";
                              })
                              .map(function (row) {
                                  return {
                                      descr: row.descr,
                                      name: row.name,
                                      time: row.time,
                                      time_to: row.time_to,
                                  };
                              })
                        : [];
                else result = data == null ? null : data.epg_data;
                callback(result);
            },
            function () {
                if (available(scope, source))
                    callback(id === "antifriz" ? [] : null);
            }
        );
    }
    var driver: OwnedPlaylistDriver = {
        archive: function (channelId, start, end) {
            var row = active() && catalog.channels[channelId];
            if (!row) return "";
            var mode =
                credentials().mode ||
                (ports.userAgent().indexOf("Tizen") < 0 ? 0 : 2);
            return (
                ports.core.providerArchiveUrl(
                    id === "antifriz" ? "antifriz" : "kb",
                    id === "antifriz"
                        ? "http://" + row.server + ":80/" + channelId + "/"
                        : row.url || "",
                    id === "antifriz" ? "?token=" + row.token : row.caso || "",
                    id === "antifriz" ? "" : row.ca || "",
                    Number(start),
                    Number(end),
                    ports.now(),
                    ports.isDune(),
                    id === "antifriz" ? mode : 0
                ) || ""
            );
        },
        cancelMedia: media.cancel,
        capabilities: {
            archive: true,
            guide: true,
            media: true,
            settings: true,
        },
        configuration: function () {
            return {
                mac: mac,
                prefix: id === "kb-team" ? "kbc" + slot : "az",
                slot: slot,
            };
        },
        credentials: credentials,
        dispose: function () {
            if (disposed) return;
            disposed = true;
            revision++;
            catalogs.dispose();
            panels.dispose();
            transport.dispose();
            media.dispose();
            listeners = [];
            catalog = helpers.emptyCatalog();
        },
        guide: function (channelId, callback) {
            guide(channelId, callback, false);
        },
        id: id,
        load: function (callback) {
            if (!active()) return;
            var operation = ++revision,
                scope = catalogs.activate("catalog");
            if (!active() || !scope.active() || operation !== revision) return;
            catalog = helpers.emptyCatalog();
            var source = identity(),
                config = credentials();
            var finished = false;
            function complete(error?: string) {
                if (finished || !available(scope, source)) return;
                finished = true;
                callback(helpers.snapshot(catalog), error);
            }
            if (!ports.core.operatorCredentialsValid(id, config.username, "")) {
                complete("playlist-credentials");
                return;
            }
            var url = ports.core.operatorProfileUrl(id, "playlist", {
                key: config.username,
                list: slot,
                mac: mac,
            });
            var plan = new ports.core.OperatorPlaylistClient(
                url,
                ports.relay,
                !!ports.intercept,
                id === "antifriz" ? "classic" : "quiet",
                encodeURIComponent
            );
            var intercepted = plan.interceptUrl();
            if (intercepted && ports.intercept) ports.intercept(intercepted);
            function next(): void {
                if (!available(scope, source)) return;
                var request = plan.request();
                if (!request) {
                    complete("playlist-network");
                    return;
                }
                transport.send(
                    scope,
                    request,
                    function (text: string) {
                        if (!available(scope, source)) return;
                        plan.accept();
                        var error: string | undefined;
                        try {
                            var parsed = ports.core.parseOperatorPlaylist(
                                text,
                                id,
                                id === "kb-team"
                                    ? function (value: string) {
                                          return ports.murmur(value, 10);
                                      }
                                    : function () {
                                          return 0;
                                      },
                                []
                            );
                            if (!available(scope, source)) return;
                            parsed.entries.forEach(function (entry: any) {
                                if (entry.generatedName)
                                    entry.channel.channel_name =
                                        ports.translate("??? No channel name");
                            });
                            catalog = parsed;
                            if (parsed.malformed) error = "playlist-processing";
                        } catch (_) {
                            error = "playlist-processing";
                        }
                        complete(error);
                        if (id === "kb-team" && available(scope, source))
                            enrich(scope, source);
                    },
                    function () {
                        if (!available(scope, source)) return;
                        plan.reject();
                        if (plan.request() && plan.progress())
                            ports.progress("p...");
                        next();
                    }
                );
            }
            next();
        },
        logo: function (channelId) {
            return active() && catalog.channels[channelId]
                ? catalog.channels[channelId].logo || ""
                : "";
        },
        media: function (url, name, callback) {
            if (!active()) return;
            var source = identity();
            media.load(
                {
                    mac: mac,
                    name: name,
                    profile: id,
                    url: driver.mediaUrl(url),
                },
                function (result: MediaCatalogResult) {
                    if (active() && identity() === source) callback(result);
                }
            );
        },
        mediaUrl: function (url) {
            return ports.core.operatorVodRoot(id, url, credentials().username);
        },
        saveCredentials: function (value) {
            if (!active()) return;
            var selected = Number(value.playlist);
            if (
                id === "kb-team" &&
                (selected < 0 ||
                    selected > 2 ||
                    Math.floor(selected) !== selected)
            )
                return;
            var operation = ++revision;
            var changed =
                id === "kb-team"
                    ? String(slot) !== value.playlist
                    : credentials().username !== value.username;
            if (changed) {
                catalogs.dispose();
                if (!active() || operation !== revision) return;
                panels.dispose();
                if (!active() || operation !== revision) return;
                media.cancel();
                if (!active() || operation !== revision) return;
                catalog = helpers.emptyCatalog();
            }
            if (id === "antifriz") {
                ports.storage.set("key", value.username);
                if (value.mode !== undefined)
                    ports.storage.set("mpeg", String(value.mode));
            } else {
                slot = selected;
                ports.storage.set("v_list", String(slot));
                ports.storageFor("kbc" + slot).set("v_list", String(slot));
            }
        },
        storageKey: function (key) {
            return (id === "kb-team" ? "kbc" + slot : "az") + key;
        },
        stream: function (channelId) {
            var row = active() && catalog.channels[channelId];
            if (!row) return "";
            return id === "kb-team"
                ? row.url || ""
                : ports.core.operatorLiveUrl(id, String(channelId), row, {
                      hls: ports.userAgent().indexOf("Tizen") < 0 ? 0 : 2,
                      mode: credentials().mode,
                  });
        },
        updates: function (callback) {
            if (!active()) return function () {};
            listeners.push(callback);
            return function () {
                var index = listeners.indexOf(callback);
                if (index >= 0) listeners.splice(index, 1);
            };
        },
    };
    if (id === "antifriz")
        driver.guideCurrent = function (channelId, callback) {
            guide(channelId, callback, true);
        };
    if (id === "kb-team")
        driver.subscription = function (callback) {
            if (!active()) return function () {};
            var scope = panels.activate("account"),
                source = identity();
            transport.send(
                scope,
                {
                    dataType: "json",
                    timeout: 5000,
                    url:
                        "http://kb-team.club/info.php?box_client=ott-play&box_mac=" +
                        mac,
                },
                function (data: any) {
                    if (available(scope, source)) callback({ data: data });
                },
                function (xhr: any, status: any, error: any) {
                    if (available(scope, source))
                        callback({
                            error: { error: error, status: status, xhr: xhr },
                        });
                }
            );
            return scope.dispose;
        };
    owner.own(driver.dispose);
    return driver;
}

function reportOwnedPlaylistLoad(
    host: any,
    driver: OwnedPlaylistDriver,
    error?: string
): void {
    if (!error) return;
    if (error === "playlist-credentials") {
        if (driver.id === "kb-team")
            host.alert(
                host._("Device MAC is required for KBC (Kinoboom) playlists")
            );
        else {
            host.popupList(
                host.popupActions.indexOf(
                    host.toggleProviderSettingsVisibility
                ) + 1
            );
            host.infoBox(
                host._("Enter an application access key (8 characters).")
            );
        }
    } else host.alert(host._("Failed to load channel list!"));
}

function mountOwnedPlaylistDriver(
    host: any,
    driver: OwnedPlaylistDriver,
    owner: DriverLifetime,
    baseStore: DriverStorage
): void {
    var editor = 0,
        panel = 0;
    var cancelPanel = function () {};
    var slot = driver.configuration!().slot;
    var lists = ["IPTV #1", "IPTV #2", "IPTV #3"];
    function current(revision: number): boolean {
        return owner.active() && editor === revision;
    }
    function defaults(): void {
        if (isNaN(parseInt(host.providerGetItem("sShowArchive"), 10)))
            host.providerSetItem("sShowArchive", "1");
    }
    editSlot.menuTitle = function () {
        return host._("Built-in playlist:") + " " + lists[slot];
    };
    editSlot.menuDetail = function () {
        return host._("Built-in playlists");
    };
    editKey.menuTitle = function () {
        return host._("Access key");
    };
    editKey.menuDetail = function () {
        return host._("Enter an application access key (8 characters).");
    };
    info.menuTitle = info.menuDetail = function () {
        return host._("KBC (Kinoboom) access data");
    };
    loadSlot.menuTitle = function () {
        return host._("Load:") + " " + lists[slot];
    };
    loadSlot.menuDetail = function () {
        return host._("Load built-in playlist:") + " " + lists[slot];
    };
    editMode.menuTitle = function () {
        return host._(
            "Stream type: %1",
            driver.credentials().mode ? "MPEGTS" : "HLS"
        );
    };
    editMode.menuDetail = function () {
        return host._("Select a stream type:<br>%1", "HLS, MPEGTS");
    };
    function labels(): void {
        host.popupArray[host.popupActions.indexOf(editSlot)] =
            editSlot.menuTitle();
        host.popupArray[host.popupActions.indexOf(loadSlot)] =
            loadSlot.menuTitle();
    }
    function editKey(): void {
        if (!owner.active()) return;
        var revision = ++editor,
            previous = driver.credentials().username;
        host.editCaption = host._(
            "Enter an application access key (8 characters)."
        );
        host.editvar = previous;
        host.setEdit = function () {
            if (!current(revision) || previous === host.editvar) return;
            if (String(host.editvar).length !== 8) {
                host.alert(
                    host._("Enter an application access key (8 characters).")
                );
                if (current(revision)) host.showEditKey([0, 1, 2]);
                return;
            }
            var config = driver.credentials();
            config.username = String(host.editvar);
            driver.saveCredentials(config);
            if (
                !current(revision) ||
                driver.credentials().username !== config.username
            )
                return;
            editor++;
            host.restart();
        };
        host.showEditKey([0, 1, 2]);
    }
    function editMode(): void {
        if (!owner.active()) return;
        var config = driver.credentials();
        config.mode = config.mode === 1 ? 0 : 1;
        driver.saveCredentials(config);
        if (!owner.active() || driver.credentials().mode !== config.mode)
            return;
        host.popupArray[host.popupActions.indexOf(editMode)] =
            editMode.menuTitle();
        host.popupList(editMode);
        if (!owner.active()) return;
        if (!host.playType) host.playChannel(host.catIndex, host.primaryIndex);
        else if (host.playType > 0)
            host.playArchive(host.playType + host.playTime);
    }
    function editSlot(): void {
        if (!owner.active()) return;
        slot = (slot + 1) % 3;
        labels();
        host.popupList(editSlot);
    }
    function loadSlot(): void {
        if (!owner.active()) return;
        var config = driver.credentials();
        config.playlist = String(slot);
        driver.saveCredentials(config);
        if (
            !owner.active() ||
            driver.credentials().playlist !== config.playlist
        )
            return;
        host.p_pref = driver.configuration!().prefix;
        defaults();
        labels();
        host.loadChannels();
    }
    function info(): void {
        if (!owner.active()) return;
        var revision = ++panel;
        cancelPanel();
        if (!owner.active() || revision !== panel) return;
        host.saveListPanelState();
        host.listCaption.innerHTML = host._("KBC (Kinoboom) access data");
        var close = function () {
            if (
                !owner.active() ||
                panel !== revision ||
                host.aboutKeyHandler !== close
            )
                return true;
            panel++;
            cancelPanel();
            if (!owner.active() || host.aboutKeyHandler !== close) return true;
            host.restoreListPanelState();
            host.$("#listAbout").hide();
            return true;
        };
        host.aboutKeyHandler = close;
        host.$("#listAbout").html(host._("Loading. Please wait...")).show();
        cancelPanel = driver.subscription!(function (result: any) {
            if (
                !owner.active() ||
                panel !== revision ||
                host.aboutKeyHandler !== close
            )
                return;
            var text =
                host.metadataText ||
                function (value: any) {
                    return String(value)
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;");
                };
            var value = result.data;
            var body = result.error
                ? host._("ERROR!") +
                  "<br/><br/>jqXHR:" +
                  text(JSON.stringify(result.error.xhr)) +
                  "<br/>textStatus: " +
                  text(result.error.status) +
                  "<br/>errorThrown: " +
                  text(result.error.error)
                : value &&
                    value.title === "KinoBoom User Info" &&
                    Array.isArray(value.channels)
                  ? value.channels
                        .filter(function (row: any) {
                            return row && row.title !== "Speedtest";
                        })
                        .map(function (row: any) {
                            return text(row.title) + "<br/>";
                        })
                        .join("")
                  : host._("Failed to get user data!!!");
            host.$("#listAbout").html(body);
        });
    }
    if (driver.id === "kb-team") host.p_pref = driver.configuration!().prefix;
    else host.mp4 = false;
    host.duneAddSettings = function (index: number) {
        if (!owner.active()) return;
        defaults();
        if (driver.id === "antifriz") {
            host.popupArray.splice(
                index,
                0,
                editKey.menuTitle(),
                editMode.menuTitle()
            );
            host.popupDetail.splice(
                index,
                0,
                editKey.menuDetail(),
                editMode.menuDetail()
            );
            host.popupActions.splice(index, 0, editKey, editMode);
        } else {
            if (isNaN(parseInt(host.stbGetItem("sNoSmall"), 10))) {
                host.stbSetItem("sNoSmall", "1");
                host.sNoSmall = 1;
            }
            host.popupArray.splice(index, 1, "", "", info.menuTitle());
            host.popupDetail.splice(
                index,
                1,
                editSlot.menuDetail(),
                loadSlot.menuDetail(),
                info.menuDetail()
            );
            host.popupActions.splice(index, 1, editSlot, loadSlot, info);
            labels();
        }
    };
    owner.own(
        driver.updates(function (snapshot, kind) {
            if (!owner.active()) return;
            Object.keys(snapshot.channels).forEach(function (id) {
                var current = host.channels && host.channels[id];
                if (!current) return;
                if (kind === "guide")
                    current.epg_url = snapshot.channels[id].epg_url;
                else current.logo = snapshot.channels[id].logo;
            });
            var id = (host.curList || [])[host.primaryIndex];
            if (id !== undefined && host.channels && host.channels[id]) {
                if (kind === "guide")
                    if (host.__ottClassicGuide)
                        host.__ottClassicGuide.invalidateChannel(Number(id));
                if (typeof host.updateChannelInfo === "function")
                    host.updateChannelInfo(id);
            }
        })
    );
    var mediaRevision = 0,
        busyMedia: { close(): void } | null = null;
    function releaseMedia(): void {
        var previous = busyMedia;
        busyMedia = null;
        if (previous) previous.close();
        driver.cancelMedia();
    }
    function cancelMedia(): void {
        mediaRevision++;
        releaseMedia();
    }
    var mediaClient = { cancel: cancelMedia, dispose: cancelMedia };
    host.providerMediaClient = mediaClient;
    owner.own(function () {
        cancelMedia();
        if (host.providerMediaClient === mediaClient)
            host.providerMediaClient = null;
    });
    host.getMediaArray = function (url: any, callback: any) {
        if (!owner.active()) return;
        var revision = ++mediaRevision;
        releaseMedia();
        var current = function () {
            return (
                owner.active() &&
                host.providerMediaClient === mediaClient &&
                mediaRevision === revision &&
                (!callback.isCurrent || callback.isCurrent())
            );
        };
        if (!current()) return;
        var target = driver.mediaUrl(String(url || ""));
        if (host.mediaUrls && host.mediaUrls.length)
            host.mediaUrls[host.mediaUrls.length - 1] = target;
        var previousHandler = host.dialogBoxKeyHandler;
        var handler = function (key: number): boolean {
            if (!current() || host.dialogBoxKeyHandler !== handler)
                return false;
            if (key !== host.keys.RETURN && key !== host.keys.STOP)
                return false;
            cancelMedia();
            return true;
        };
        var busy = {
            close: function () {
                if (host.dialogBoxKeyHandler !== handler) return;
                host.dialogBoxKeyHandler = previousHandler;
                host.$("#dialogbox").hide();
            },
        };
        busyMedia = busy;
        host.dialogBoxKeyHandler = handler;
        host.$("#dialogbox")
            .html(
                '<span class="ott-spinner ott-spinner--inline" aria-hidden="true"><span class="blob"></span><span class="blob"></span><span class="blob"></span><span class="blob"></span></span> ' +
                    host._("Download! Wait ...")
            )
            .show();
        driver.media(target, host.mediaName, function (result) {
            if (busyMedia === busy) busyMedia = null;
            busy.close();
            if (!current()) return;
            if (host.mediaUrls && host.mediaUrls.length)
                host.mediaUrls[host.mediaUrls.length - 1] = result.url;
            if (result.records) {
                host.mediaName = result.name;
                host.mediaRecords = result.records;
            }
            if (
                result.error &&
                result.error !== "network" &&
                result.error !== "catalog"
            )
                host.alert(
                    host._("Unable to load playlist") +
                        " (" +
                        result.error.toUpperCase() +
                        ")"
                );
            if (!current()) return;
            callback();
        });
    };
}
(window as any).__ottPlaylistDrivers = {
    create: createOwnedPlaylistDriver,
    mount: mountOwnedPlaylistDriver,
    reportLoad: reportOwnedPlaylistLoad,
};
// OTTPLAY_FULL_ONLY_END
