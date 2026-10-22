interface EdemDriverPorts extends ProviderDriverPorts {
    murmur(value: string, seed: number): number;
}
interface EdemDriverHelpers {
    emptyCatalog(): DriverCatalog;
    snapshot(catalog: DriverCatalog): DriverCatalog;
    transport(
        ports: ProviderDriverPorts,
        owner: DriverLifetime,
        active: () => boolean
    ): {
        dispose(): void;
        send(
            scope: DriverLifetime,
            request: DriverHttpRequest,
            done: (value: any) => void,
            fail: (...args: any[]) => void
        ): void;
    };
}
interface EdemSettings {
    cdn: string;
    key: string;
    list: number;
    portal: string;
}
interface EdemMediaView {
    error?: string;
    name?: string;
    records: any[];
    selected?: number;
}
interface EdemMediaPlayback {
    error?: string;
    item: any;
    names: string[];
    selected: number;
    variants: any;
}
interface EdemProviderDriver extends ProviderDriver {
    mediaCancel(): void;
    mediaLoad(
        target: any,
        pageSize: number,
        callback: (view: EdemMediaView) => void
    ): void;
    mediaPage(index: number, callback: (view: EdemMediaView) => void): void;
    mediaResolve(
        item: any,
        callback: (result: EdemMediaPlayback) => void
    ): void;
    mediaSource(): string;
    saveSettings(value: EdemSettings): boolean;
    settings(): EdemSettings;
}

// OTTPLAY_FULL_ONLY_BEGIN
function edemDetached(value: any): any {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(edemDetached);
    var result: any = {};
    Object.keys(value).forEach(function (key) {
        Object.defineProperty(result, key, {
            configurable: true,
            enumerable: true,
            value: edemDetached(value[key]),
            writable: true,
        });
    });
    return result;
}
function edemMediaParent(value: any): any {
    var parent: any = {};
    // Only inherited metadata reaches OperatorPortal.item. The response also
    // contains the entire catalog, which must not be copied for every item.
    [
        "title",
        "img",
        "imglr",
        "year",
        "duration",
        "agelimit",
        "description",
    ].forEach(function (key) {
        if (Object.prototype.propertyIsEnumerable.call(value, key))
            parent[key] = edemDetached(value[key]);
    });
    return parent;
}
function edemText(value: any): string {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function edemDescription(
    item: any,
    translate: (value: string) => string
): string {
    var image = item.img || item.imglr;
    if (
        typeof image !== "string" ||
        /[\u0000-\u001f]/.test(image) ||
        /^\s*(?:javascript|vbscript|data):/i.test(image)
    )
        image = "";
    function field(value: any, title: string): string {
        return value
            ? "<b>" +
                  edemText(translate(title)) +
                  ": </b>" +
                  edemText(value) +
                  "<br>"
            : "";
    }
    return (
        '<table><center><b><span style="font-size: 140%;">' +
        edemText(item.title) +
        "</span></b></center><p>" +
        (image
            ? '<img height="285" width="210" src="' +
              edemText(image) +
              '" style="float: left; margin-right: 5px; margin-bottom: 5px; border-width: 0px; border-style: solid;" onerror="this.width=0;this.height=0;">'
            : "") +
        field(item.year, "Release date") +
        field(
            item.duration
                ? Math.round(item.duration) + " " + translate("min")
                : "",
            "Duration"
        ) +
        field(item.agelimit, "Age") +
        (item.description
            ? "<p><hr><b>" +
              edemText(translate("Description")) +
              ": </b>" +
              edemText(item.description) +
              "</p>"
            : "") +
        "</table>"
    );
}

/** Protocol state is per instance. Only the mount function below knows the retained UI. */
function createEdemProviderDriver(
    ports: EdemDriverPorts,
    owner: DriverLifetime,
    helpers: EdemDriverHelpers
): EdemProviderDriver {
    var disposed = false,
        operation = 0,
        mediaRevision = 0;
    var catalog = helpers.emptyCatalog();
    var loads = ports.createLifetime(),
        navigation = ports.createLifetime(),
        pages = ports.createLifetime(),
        playing = ports.createLifetime();
    var mediaRows: any[] = [],
        mediaName: string | undefined,
        mediaParams: any = null,
        mediaEndpoint = "",
        mediaKey = "";
    function active() {
        return !disposed && owner.active();
    }
    var transport = helpers.transport(ports, owner, active);
    function settings(): EdemSettings {
        return {
            cdn: ports.storage.get("edcdn") || "",
            key: ports.storage.get("key") || "",
            list: parseInt(ports.storage.get("list") || "", 10) || 0,
            portal: ports.storage.get("vpurl") || "",
        };
    }
    function rootPortalRoute(): any {
        var link = settings().portal;
        var route = ports.core.operatorPortalNavigate(
            "",
            "Edem.tv / iLook.tv",
            link,
            "",
            decodeURIComponent
        );
        var header = /^portal::\[key:[^\]]*\]/.exec(link);
        // The header owns its first closing bracket; all later brackets belong
        // to the endpoint (including IPv6 and opaque path/query parameters).
        if (header) route.endpoint = link.slice(header[0].length);
        return route;
    }
    function scheme(): string {
        if (ports.scheme) return ports.scheme();
        var location = ports.location ? ports.location() : "";
        var match = /^https?:/i.exec(location);
        return match ? match[0] + "//" : "https://";
    }
    function mediaCancel() {
        var version = ++mediaRevision;
        navigation.dispose();
        if (version !== mediaRevision) return;
        pages.dispose();
        if (version !== mediaRevision) return;
        playing.dispose();
    }
    function mediaSource(): string {
        return "edem:" + ports.murmur(settings().portal, 0);
    }
    function stampMedia(record: any): any {
        if (!record) return record;
        record.vportalSource = mediaSource();
        if (record.playlist_url && typeof record.playlist_url === "object")
            record.playlist_url.vportalSource = record.vportalSource;
        return record;
    }
    function mediaView(error?: string, selected?: number): EdemMediaView {
        return {
            error: error,
            name: mediaName,
            records: edemDetached(mediaRows).map(stampMedia),
            selected: selected,
        };
    }
    function mediaRecord(value: any, parent: any) {
        var item = ports.core.operatorPortalItem(
            edemDetached(value),
            edemDetached(parent)
        );
        return item
            ? ports.core.operatorPortalMedia(
                  item,
                  edemDescription(item, ports.translate)
              )
            : undefined;
    }
    function mediaRequest(
        scope: DriverLifetime,
        endpoint: string,
        params: any,
        done: (data: any) => void,
        fail: () => void
    ) {
        transport.send(
            scope,
            {
                data: JSON.stringify(params),
                dataType: "json",
                timeout: 30000,
                type: "post",
                url: endpoint,
            },
            done,
            fail
        );
    }
    var driver: EdemProviderDriver = {
        archive: function (id, start, end) {
            return active() && catalog.channels[id]
                ? ports.core.providerArchiveUrl(
                      "utc-now",
                      driver.stream(id),
                      "",
                      "",
                      Number(start),
                      Number(end),
                      ports.now(),
                      ports.isDune(),
                      0
                  ) || ""
                : "";
        },
        capabilities: {
            archive: true,
            guide: true,
            media: true,
            settings: true,
        },
        credentials: function () {
            var value = settings();
            return {
                mode: value.list,
                password: "",
                playlist: value.portal,
                server: value.cdn,
                username: value.key,
            };
        },
        dispose: function () {
            if (disposed) return;
            disposed = true;
            operation++;
            loads.dispose();
            mediaCancel();
            transport.dispose();
            catalog = helpers.emptyCatalog();
            mediaRows = [];
            mediaParams = null;
        },
        guide: function (id, callback) {
            if (!active()) return;
            var row = catalog.channels[id];
            if (!row || !row.epg) {
                callback(null);
                return;
            }
            var scope = loads.current() || loads.activate("guide");
            if (!active() || !scope.active()) return;
            var config = settings();
            transport.send(
                scope,
                {
                    dataType: "json",
                    timeout: 10000,
                    url:
                        scheme() +
                        "epg.drm-play.com/" +
                        (config.list === 1 ? "iptv-e2-soveni" : "edem") +
                        "/epg/" +
                        row.epg +
                        ".json",
                },
                function (data) {
                    callback(
                        data && data.epg_data
                            ? edemDetached(data.epg_data)
                            : null
                    );
                },
                function () {
                    callback(null);
                }
            );
        },
        id: "edem",
        load: function (callback) {
            if (!active()) return;
            var version = ++operation,
                scope = loads.activate("catalog");
            if (!active() || !scope.active() || version !== operation) return;
            catalog = helpers.emptyCatalog();
            var config = settings(),
                finished = false;
            var url = ports.core.operatorProfileUrl("edem", "playlist", {
                list: config.list,
                scheme: scheme(),
            });
            var plan = new ports.core.OperatorPlaylistClient(
                url,
                ports.relay,
                !!ports.intercept,
                "quiet",
                encodeURIComponent
            );
            var intercepted = plan.interceptUrl();
            if (intercepted && ports.intercept) ports.intercept(intercepted);
            function complete(error?: string) {
                if (finished || !active() || !scope.active()) return;
                finished = true;
                callback(helpers.snapshot(catalog), error);
            }
            function next() {
                if (!active() || !scope.active()) return;
                var request = plan.request();
                if (!request) {
                    complete("edem-network");
                    return;
                }
                transport.send(
                    scope,
                    request,
                    function (text) {
                        plan.accept();
                        var error: string | undefined;
                        try {
                            var parsed = ports.core.parseOperatorPlaylist(
                                text,
                                "edem",
                                function () {
                                    return 0;
                                },
                                []
                            );
                            parsed.entries.forEach(function (entry: any) {
                                if (entry.generatedName)
                                    entry.channel.channel_name =
                                        ports.translate("??? No channel name");
                            });
                            catalog = parsed;
                            if (parsed.malformed) error = "edem-processing";
                        } catch (_) {
                            catalog = helpers.emptyCatalog();
                            error = "edem-processing";
                        }
                        complete(error);
                    },
                    function () {
                        plan.reject();
                        next();
                    }
                );
            }
            next();
        },
        logo: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].logo || ""
                : "";
        },
        mediaCancel: mediaCancel,
        mediaLoad: function (target, pageSize, callback) {
            if (!active()) return;
            var version = mediaRevision + 1;
            mediaCancel();
            if (!active() || version !== mediaRevision) return;
            var scope = navigation.activate("media");
            if (!active() || version !== mediaRevision || !scope.active())
                return;
            var route: any,
                localView = false;
            try {
                if (
                    target &&
                    target.vportalSource &&
                    target.vportalSource !== mediaSource()
                )
                    throw new Error("Retired portal node");
                var root = rootPortalRoute();
                route =
                    target === "" || target == null
                        ? root
                        : ports.core.operatorPortalNavigate(
                              edemDetached(target),
                              "Edem.tv / iLook.tv",
                              settings().portal,
                              root.key,
                              decodeURIComponent
                          );
                mediaEndpoint = root.endpoint;
                mediaKey = root.key;
                if (!mediaEndpoint) throw new Error("Missing portal endpoint");
                if (route.action === "FILTERS" || route.action === "FILTER") {
                    var values =
                        route.action === "FILTERS"
                            ? route.node.filters
                            : route.node.items;
                    mediaRows = values.map(function (value: any) {
                        return ports.core.operatorPortalFilter(
                            value,
                            route.action === "FILTERS"
                        );
                    });
                    mediaParams = null;
                    localView = true;
                } else
                    mediaParams = ports.core.operatorPortalParams(
                        mediaKey,
                        route.node.request,
                        Math.max(
                            1,
                            Math.min(1000, Number(pageSize) * 10 || 300)
                        )
                    );
            } catch (_) {
                mediaRows = [];
                mediaParams = null;
                callback(mediaView("media-processing"));
                return;
            }
            if (localView) {
                callback(mediaView());
                return;
            }
            var params = edemDetached(mediaParams);
            mediaRequest(
                scope,
                mediaEndpoint,
                params,
                function (data) {
                    var error: string | undefined;
                    mediaRows = [];
                    try {
                        var decoder =
                                new ports.core.OperatorPortalCatalogClient(
                                    data,
                                    false
                                ),
                            row: any,
                            parent: any;
                        if (decoder.named()) mediaName = route.node.mediaName;
                        while ((row = decoder.next())) {
                            if (row.kind === "ERROR") error = "media-rejected";
                            else if (row.kind === "MEDIA")
                                mediaRows.push(
                                    mediaRecord(
                                        row.value,
                                        parent ||
                                            (parent = edemMediaParent(data))
                                    )
                                );
                            else if (row.kind === "LAZY")
                                mediaRows.push({
                                    edemLazy: true,
                                    logo_30x30: "",
                                    stream_url: "",
                                    title:
                                        row.index +
                                        1 +
                                        " " +
                                        ports.translate("Download! Wait ..."),
                                });
                            else if (row.kind === "SEARCH")
                                mediaRows.push({
                                    description: ports.translate("Search"),
                                    playlist_url: "search",
                                    search_on: 1,
                                    title: ports.translate("Search"),
                                });
                            else if (row.kind === "FILTERS")
                                mediaRows.push({
                                    description: ports.translate("Filters"),
                                    playlist_url: {
                                        a: "filters",
                                        filters: edemDetached(row.value),
                                    },
                                    title: ports.translate("Filters"),
                                });
                        }
                    } catch (_) {
                        error = "media-processing";
                    }
                    callback(mediaView(error));
                },
                function () {
                    callback(mediaView("media-network"));
                }
            );
        },
        mediaPage: function (index, callback) {
            if (!active() || !mediaParams || !mediaEndpoint) return;
            var version = mediaRevision,
                scope = pages.activate("page");
            if (!active() || !scope.active() || version !== mediaRevision)
                return;
            var params = ports.core.operatorPortalPage(
                edemDetached(mediaParams),
                index
            );
            function complete(error?: string) {
                var selected = ports.core.operatorPortalSelection(
                    index,
                    params.offset,
                    params.limit,
                    mediaRows.map(function (row) {
                        return !!row && !!row.edemLazy;
                    })
                );
                if (selected !== index)
                    mediaRows.length = Math.max(0, selected + 1);
                callback(mediaView(error, selected));
            }
            mediaRequest(
                scope,
                mediaEndpoint,
                params,
                function (data) {
                    var error: string | undefined;
                    try {
                        var decoder =
                                new ports.core.OperatorPortalCatalogClient(
                                    data,
                                    true
                                ),
                            row: any,
                            parent: any;
                        while ((row = decoder.next())) {
                            if (row.kind === "ERROR") error = "media-rejected";
                            else
                                mediaRows[params.offset + row.index] =
                                    mediaRecord(
                                        row.value,
                                        parent ||
                                            (parent = edemMediaParent(data))
                                    );
                        }
                    } catch (_) {
                        error = "media-processing";
                    }
                    complete(error);
                },
                function () {
                    complete("media-network");
                }
            );
        },
        mediaResolve: function (item, callback) {
            if (!active() || !item) return;
            var version = mediaRevision + 1;
            mediaCancel();
            if (!active() || version !== mediaRevision) return;
            var scope = playing.activate("play");
            if (!active() || !scope.active() || version !== mediaRevision)
                return;
            var playable = edemDetached(item),
                route: any,
                params: any;
            function failed(error: string) {
                callback({
                    error: error,
                    item: playable,
                    names: [],
                    selected: 0,
                    variants: {},
                });
            }
            try {
                if (
                    playable.vportalSource &&
                    playable.vportalSource !== mediaSource()
                )
                    throw new Error("Retired portal media");
                playable.vportalSource = mediaSource();
                route = rootPortalRoute();
                if (!route.endpoint) throw new Error("Missing portal endpoint");
                params = ports.core.operatorPortalParams(
                    route.key,
                    playable.request
                );
            } catch (_) {
                failed("media-processing");
                return;
            }
            mediaRequest(
                scope,
                route.endpoint,
                params,
                function (data) {
                    if (
                        !data ||
                        data.type === "error" ||
                        typeof data.url !== "string" ||
                        !data.url
                    ) {
                        failed("media-rejected");
                        return;
                    }
                    playable.stream_url = data.url;
                    var variants = edemDetached(data.variants || {}),
                        choice = ports.core.operatorPortalVariants(
                            variants,
                            data.url
                        );
                    callback({
                        item: playable,
                        names: choice.keys,
                        selected: choice.selected,
                        variants: variants,
                    });
                },
                function () {
                    failed("media-network");
                }
            );
        },
        mediaSource: mediaSource,
        saveCredentials: function (value) {
            driver.saveSettings({
                cdn: value.server,
                key: value.username,
                list: value.mode || 0,
                portal: value.playlist || "",
            });
        },
        saveSettings: function (value) {
            if (!active()) return false;
            var previous = settings(),
                version = ++operation;
            if (
                previous.key === value.key &&
                previous.list === value.list &&
                previous.cdn === value.cdn &&
                previous.portal === value.portal
            )
                return true;
            loads.dispose();
            if (!active() || version !== operation) return false;
            var expectedMedia = mediaRevision + 1;
            mediaCancel();
            if (
                !active() ||
                version !== operation ||
                expectedMedia !== mediaRevision
            )
                return false;
            var fields = ["key", "list", "cdn", "portal"],
                keys = ["key", "list", "edcdn", "vpurl"];
            for (var i = 0; i < fields.length; i++) {
                if ((previous as any)[fields[i]] !== (value as any)[fields[i]])
                    ports.storage.set(
                        keys[i],
                        String((value as any)[fields[i]])
                    );
                if (!active() || version !== operation) return false;
            }
            if (previous.portal !== value.portal) {
                mediaRows = [];
                mediaParams = null;
                mediaName = undefined;
                mediaEndpoint = "";
                mediaKey = "";
            }
            return true;
        },
        settings: settings,
        stream: function (id) {
            var value = settings();
            return active() && catalog.channels[id]
                ? ports.core.operatorLiveUrl(
                      "edem",
                      String(id),
                      catalog.channels[id],
                      { host: value.cdn, key: value.key }
                  )
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

function reportEdemProviderLoad(
    host: any,
    driver: EdemProviderDriver,
    error?: string
): void {
    if (error) {
        host.alert(host._("Failed to load channel list!"));
        return;
    }
    var value = driver.settings();
    var message = !host.OttPlayCore.operatorCredentialsValid(
        "edem",
        value.key,
        ""
    )
        ? "Access key is required!"
        : !host.OttPlayCore.operatorEdemHost(value.cdn)
          ? "Channel link is required!"
          : "";
    if (!message) return;
    host.duneAddSettings.edemSettings();
    host.infoBox(
        "<br>" +
            host._(message) +
            "<br><br>" +
            host.renderButtonHint(host.keys.ENTER, host.strENTER, "Close")
    );
}

/** Explicit compatibility codec: menus and media rows are detached from protocol state. */
function mountEdemProvider(
    host: any,
    driver: EdemProviderDriver,
    owner: DriverLifetime,
    _store: DriverStorage
): void {
    if (!owner.active()) return;
    var revision = 0,
        editor = 0,
        dialog: any = null,
        previousDialog: any = null,
        pageIndex: number | null = null;
    var title = "Edem.tv / iLook.tv";
    var remotePortal: any = null;
    var remotePortalLink = "";
    var lists = [
        host._("epg.one (Standard)"),
        "soveni",
        host._("epg.one (Thematic)"),
        host._("epg.one (Ordered)"),
    ];
    var portalHint =
        host._("Enter the VPortal link as shown in the cabinet") +
        ":<br><b>portal::[key:...</b>";
    // Translation is an injected host callback and may replace this provider.
    if (!owner.active()) return;
    function active() {
        return owner.active() && host.providerMediaClient === client;
    }
    function hideDialog() {
        if (dialog && host.dialogBoxKeyHandler === dialog) {
            host.$("#dialogbox").hide();
            host.dialogBoxKeyHandler = previousDialog;
        }
        dialog = null;
        previousDialog = null;
    }
    function cancel() {
        revision++;
        pageIndex = null;
        hideDialog();
        driver.mediaCancel();
        if (remotePortal) remotePortal.cancel();
    }
    function queuePortal() {
        if (!active()) return null;
        var link = driver.settings().portal;
        if (remotePortal && remotePortalLink === link) return remotePortal;
        if (remotePortal) remotePortal.dispose();
        remotePortal = null;
        remotePortalLink = link;
        var parsed =
            typeof host.parseVPortalLink === "function"
                ? host.parseVPortalLink(link)
                : null;
        if (
            !active() ||
            !parsed ||
            typeof host.createVPortalClient !== "function" ||
            (typeof host.checkProviderUrl === "function" &&
                !host.checkProviderUrl(parsed.url))
        )
            return null;
        remotePortal = host.createVPortalClient(link, {
            isCurrent: function () {
                return active() && driver.settings().portal === link;
            },
            sourceId: driver.mediaSource(),
            title: title,
        });
        return remotePortal;
    }
    var client = {
        cancel: cancel,
        cancelAutomatic: function () {
            if (remotePortal) remotePortal.cancelAutomatic();
        },
        dispose: function () {
            cancel();
            if (remotePortal) remotePortal.dispose();
            remotePortal = null;
        },
        resolve: function (item: any, done: any, automatic?: boolean) {
            if (item.__ottVPortalQueue) {
                var portal = queuePortal();
                if (portal) portal.resolve(item, done, automatic);
            } else play(item, done);
        },
        search: function (query: string, done: any, guard?: () => boolean) {
            var portal = queuePortal();
            if (portal) return portal.search(query, done, guard);
            done({ error: "VPortal is not configured.", items: [] });
            return function () {};
        },
    };
    host.providerMediaClient = client;
    owner.own(function () {
        client.dispose();
        if (host.providerMediaClient === client)
            host.providerMediaClient = null;
    });
    if (!active()) return;
    function current(token: number, view: any): boolean {
        return active() && revision === token && host._mediaLoadState === view;
    }
    function busy() {
        previousDialog = host.dialogBoxKeyHandler;
        var handler = function (key: number) {
            if (!active() || host.dialogBoxKeyHandler !== handler) return false;
            if (
                key !== host.keys.RETURN &&
                key !== host.keys.EXIT &&
                key !== host.keys.STOP
            )
                return false;
            cancel();
            if (active() && typeof host.closeList === "function")
                host.closeList();
            if (
                active() &&
                key === host.keys.STOP &&
                typeof host.stbStop === "function"
            )
                host.stbStop();
            return true;
        };
        dialog = handler;
        host.dialogBoxKeyHandler = handler;
        host.$("#dialogbox")
            .html(edemText(host._("Download! Wait ...")))
            .show();
    }
    function report(error?: string) {
        if (error) host.alert(host._("VPortal request failed"));
    }
    function project(
        rows: any[],
        token: number,
        accepted?: any[],
        publish?: any
    ): any[] {
        var projected = accepted || [];
        projected.length = rows.length;
        rows.forEach(function (row, index) {
            projected[index] = row;
            if (!row || !row.edemLazy) return;
            delete row.edemLazy;
            row.description = function () {
                if (
                    !active() ||
                    revision !== token ||
                    (!publish && host.mediaRecords !== projected)
                )
                    return "";
                var selected = host.selIndex,
                    view = host._mediaLoadState;
                if (pageIndex === selected) return host._("Download! Wait ...");
                pageIndex = selected;
                hideDialog();
                busy();
                driver.mediaPage(selected, function (result) {
                    if (
                        !current(token, view) ||
                        (!publish && host.mediaRecords !== projected)
                    )
                        return;
                    pageIndex = null;
                    hideDialog();
                    report(result.error);
                    if (
                        !current(token, view) ||
                        (!publish && host.mediaRecords !== projected)
                    )
                        return;
                    project(result.records, token, projected, publish);
                    if (publish) {
                        publish(projected, undefined, result.selected);
                        return;
                    }
                    if (result.selected !== undefined)
                        host.selIndex = result.selected;
                    host.showPage();
                });
                return host._("Download! Wait ...");
            };
        });
        return projected;
    }
    function loadMedia(target: any, callback: any) {
        if (!active()) return;
        var token = revision + 1;
        cancel();
        if (!active() || token !== revision) return;
        var view = host._mediaLoadState;
        if (callback.isCurrent && !callback.isCurrent()) return;
        busy();
        driver.mediaLoad(target, host.sPageSize, function (result) {
            if (
                !current(token, view) ||
                (callback.isCurrent && !callback.isCurrent())
            )
                return;
            hideDialog();
            report(result.error);
            if (
                !current(token, view) ||
                (callback.isCurrent && !callback.isCurrent())
            )
                return;
            host.mediaRecords = project(
                result.records,
                token,
                undefined,
                callback.publish
            );
            if (result.name !== undefined) host.mediaName = result.name;
            callback();
        });
    }
    function synchronizeMedia() {
        var enabled = driver.settings().portal;
        if (active()) host.getMediaArray = enabled ? loadMedia : null;
    }
    function play(item: any, resolved?: (item: any) => void) {
        if (!active()) return;
        var token = revision + 1;
        cancel();
        if (!active() || token !== revision) return;
        var view = host._mediaLoadState;
        host.showPage();
        if (!current(token, view)) return;
        busy();
        // Legacy Edem history was already scoped by its provider storage prefix.
        // Give its request-bearing entries an identity without rewriting old URLs.
        if (Array.isArray(host.medHistory))
            host.medHistory.forEach(function (entry: any) {
                if (entry && entry.request && !entry.vportalSource)
                    entry.vportalSource = driver.mediaSource();
            });
        driver.mediaResolve(item, function (result) {
            if (!current(token, view)) return;
            hideDialog();
            if (result.error) {
                report(result.error);
                return;
            }
            function start(url: string) {
                if (!current(token, view) || typeof url !== "string" || !url)
                    return;
                var playable = edemDetached(result.item);
                playable.stream_url = url;
                hideDialog();
                if (resolved) {
                    resolved(playable);
                    return;
                }
                host.closeList();
                // Closing the renderer intentionally cancels this completed operation.
                if (active()) host._playMedia(playable);
            }
            if (result.names.length < 2) {
                start(result.item.stream_url);
                return;
            }
            var selected = result.selected;
            function render() {
                var html = edemText(host._("Quality")) + ":<br/><br/>";
                result.names.forEach(function (name, index) {
                    html +=
                        '<div id="edemQuality' +
                        index +
                        '" style="display:inline-block;padding:6px 16px;' +
                        (index === selected
                            ? "background-color:" +
                              host.curColorB +
                              ";color:" +
                              host.curColor +
                              ";"
                            : "") +
                        '">' +
                        edemText(name) +
                        "</div>&nbsp;&nbsp;";
                });
                host.$("#dialogbox").html(html).show();
                result.names.forEach(function (_name, index) {
                    host.$("#edemQuality" + index).on("click", function () {
                        if (
                            !current(token, view) ||
                            host.dialogBoxKeyHandler !== handler
                        )
                            return;
                        if (selected === index)
                            start(result.variants[result.names[index]]);
                        else {
                            selected = index;
                            render();
                        }
                    });
                });
            }
            var handler = function (key: number) {
                if (
                    !current(token, view) ||
                    host.dialogBoxKeyHandler !== handler
                )
                    return false;
                if (
                    key === host.keys.RETURN ||
                    key === host.keys.EXIT ||
                    key === host.keys.STOP
                ) {
                    cancel();
                    if (active() && key === host.keys.STOP && host.stbStop)
                        host.stbStop();
                    return true;
                }
                if (key === host.keys.ENTER) {
                    start(result.variants[result.names[selected]]);
                    return true;
                }
                if (key === host.keys.LEFT)
                    selected =
                        (selected + result.names.length - 1) %
                        result.names.length;
                else if (key === host.keys.RIGHT)
                    selected = (selected + 1) % result.names.length;
                else if (key === host.keys.UP)
                    selected = Math.min(1, result.names.length - 1);
                else if (key === host.keys.DOWN) selected = 0;
                else return false;
                render();
                return true;
            };
            previousDialog = host.dialogBoxKeyHandler;
            dialog = handler;
            host.dialogBoxKeyHandler = handler;
            render();
        });
    }
    host.playMedia = play;
    host.parental = /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults|взрослые/i;
    function refresh() {
        var value = driver.settings();
        host.listArray = [
            host._("Access key"),
            host._("Channel link") +
                ": " +
                (host.OttPlayCore.operatorEdemHost(value.cdn) || "—"),
            host._("List type") + ": " + lists[value.list],
            host._("VPortal link"),
            "",
            (host.sNoNumbersKeys ? "" : '<div class="btn">8</div> ') +
                host._("Load playlist"),
        ];
        host.listDataArray = host.listArray;
    }
    function edit(field: "key" | "cdn" | "portal") {
        if (!active()) return;
        var version = ++editor;
        host.editCaption = host._(
            field === "key"
                ? "Edit access key"
                : field === "cdn"
                  ? "Edit channel link"
                  : "Edit VPortal link"
        );
        host.editvar = driver.settings()[field];
        host.setEdit = function () {
            if (!active() || version !== editor) return;
            var next = driver.settings(),
                value = String(host.editvar || "");
            if (field === "cdn") {
                value = value
                    .trim()
                    .replace(/^https?:\/\//i, "")
                    .split("/")[0];
                if (value && !/^[A-Za-z0-9][A-Za-z0-9.-]{4,}$/.test(value)) {
                    host.alert(
                        host._(
                            "Invalid channel link! Enter the full host as in the cabinet stream URL (e.g. subdomain.cdn-domain.tld)"
                        )
                    );
                    if (active() && version === editor) host.showEditKey();
                    return;
                }
            } else if (field === "portal") {
                var header =
                    /^portal::(?:\[|%5b)key:([\s\S]*?)(?:\]|%5d)/i.exec(value);
                if (header)
                    value =
                        "portal::[key:" +
                        header[1] +
                        "]" +
                        value.slice(header[0].length);
                if (value && value.indexOf("portal::[key:") !== 0) {
                    host.alert(portalHint);
                    if (active() && version === editor) host.showEditKey();
                    return;
                }
            }
            if (value === next[field]) return;
            next[field] = value;
            if (!driver.saveSettings(next) || !active() || version !== editor)
                return;
            editor++;
            cancel();
            if (!active()) return;
            if (field === "portal") {
                synchronizeMedia();
                host.mediaUrls = null;
                host.mediaNames = [];
                host.mediaSelects = [0];
            } else {
                refresh();
                if (typeof host.playChannel === "function")
                    host.playChannel(host.catIndex, host.primaryIndex);
                if (active()) host.showPage();
            }
        };
        host.showEditKey();
    }
    function settingsMenu() {
        if (!active()) return;
        editor++;
        host.selIndex = 0;
        refresh();
        host.getListItem = function (value: any) {
            return "&nbsp;&nbsp;" + value;
        };
        host.detailListAction = function () {
            if (!active()) return;
            var after = host._(" (after changing, load playlist)");
            host.listDetail.innerHTML =
                [
                    host._("Enter access key for") + " " + title,
                    host._(
                        "Enter the full CDN host from the cabinet stream URL (e.g. subdomain.cdn-domain.tld), not a bare subdomain"
                    ) +
                        ":<br><br>" +
                        after,
                    host._(
                        "Select playlist template source for EPG and logos"
                    ) +
                        ":<br>" +
                        lists.join(", ") +
                        "<br><br>" +
                        after,
                    portalHint,
                    "",
                    host._("Load playlist"),
                ][host.selIndex] || "";
            host.listFooter.innerHTML =
                host.renderButtonHint(
                    host.keys.RETURN,
                    host.strRETURN,
                    "Close"
                ) +
                (host.selIndex === 2
                    ? host.renderButtonHint(
                          host.keys.ENTER,
                          host.strENTER,
                          "Change value",
                          host.strLEFT,
                          host.strRIGHT
                      )
                    : [0, 1, 3].indexOf(host.selIndex) !== -1
                      ? host.renderButtonHint(
                            host.keys.ENTER,
                            host.strENTER,
                            "Change value"
                        )
                      : "");
        };
        host.listKeyHandler = function (key: number) {
            if (!active()) return false;
            if (key === host.keys.RETURN) {
                host.popupList(
                    host.popupActions.indexOf(
                        host.toggleProviderSettingsVisibility
                    ) + 1
                );
                return true;
            }
            if (key === host.keys.N8) {
                host.loadChannels();
                return true;
            }
            if (
                key !== host.keys.ENTER &&
                key !== host.keys.LEFT &&
                key !== host.keys.RIGHT
            )
                return false;
            if (key !== host.keys.ENTER && host.selIndex !== 2) return false;
            if (host.selIndex === 0) edit("key");
            else if (host.selIndex === 1) edit("cdn");
            else if (host.selIndex === 2) {
                var next = driver.settings(),
                    version = editor;
                next.list =
                    (next.list +
                        (key === host.keys.LEFT ? -1 : 1) +
                        lists.length) %
                    lists.length;
                if (
                    driver.saveSettings(next) &&
                    active() &&
                    version === editor
                ) {
                    cancel();
                    if (!active() || version !== editor) return true;
                    refresh();
                    host.showPage();
                }
            } else if (host.selIndex === 3) edit("portal");
            else if (host.selIndex === 5) host.loadChannels();
            return true;
        };
        host.listDetail.innerHTML = "";
        host.listCaption.innerHTML = host._("Access settings") + " " + title;
        host.$("#listPopUp").hide();
        host.showPage();
    }
    settingsMenu.menuTitle = function () {
        return host._("Access settings") + " " + title;
    };
    host.duneAddSettings = function (index: number) {
        if (!active()) return;
        var caption = settingsMenu.menuTitle();
        if (!active()) return;
        host.popupArray.splice(index, 1, caption);
        host.popupDetail.splice(index, 1, "");
        host.popupActions.splice(index, 1, settingsMenu);
        synchronizeMedia();
    };
    host.duneAddSettings.edemSettings = settingsMenu;
    synchronizeMedia();
}

(window as any).__ottEdemDriver = {
    create: createEdemProviderDriver,
    mount: mountEdemProvider,
    reportLoad: reportEdemProviderLoad,
};
// OTTPLAY_FULL_ONLY_END
