/** API catalog instances. Domain parsing/routing is supplied by the shared core;
 * HTTP, credentials and presentation cross explicit injected boundaries. */
interface CatalogDriverHelpers {
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
interface CatalogSubscriptionResult {
    data?: any;
    error?: { xhr: any; status: any; error: any };
}
interface CatalogProviderDriver extends ProviderDriver {
    guideCurrent?: (
        id: string | number,
        callback: (value: any) => void
    ) => void;
    subscription?: (
        callback: (value: CatalogSubscriptionResult) => void
    ) => () => void;
}

// OTTPLAY_FULL_ONLY_BEGIN
function createCatalogProviderDriver(
    id: string,
    ports: ProviderDriverPorts,
    owner: DriverLifetime,
    helpers: CatalogDriverHelpers
): CatalogProviderDriver {
    if (["itv", "ottclub", "shura"].indexOf(id) === -1)
        throw new Error("Unsupported catalog provider: " + id);
    var catalog = helpers.emptyCatalog();
    var disposed = false;
    var operation = 0;
    var loads = ports.createLifetime();
    var panels = ports.createLifetime();
    var base = "http://api.01cdn.wf/";
    function active() {
        return !disposed && owner.active();
    }
    var transport = helpers.transport(ports, owner, active);
    function credentials(): ProviderCredentials {
        return {
            mode: parseInt(ports.storage.get("mpeg") || "0", 10) || 0,
            password: "",
            server:
                id === "ottclub"
                    ? ports.storage.get("ottwww") || ""
                    : id === "shura"
                      ? ports.storage.get("server") || "1"
                      : "",
            username:
                ports.storage.get(id === "ottclub" ? "ottkey" : "key") || "",
        };
    }
    function options() {
        var value = credentials();
        return { key: value.username, mode: value.mode, server: value.server };
    }
    function readGuide(
        channelId: string | number,
        callback: (value: any) => void,
        current: boolean
    ) {
        if (!active()) return;
        var scope = loads.current() || loads.activate("guide");
        if (!active() || !scope.active()) return;
        var source = new ports.core.OperatorGuideClient(id, current);
        var config = credentials();
        var channel = catalog.channels && catalog.channels[channelId];
        var rec = channel && channel.rec;
        var finished = false;
        function complete(value: any) {
            if (finished || !active() || !scope.active()) return;
            finished = true;
            callback(value);
        }
        function next() {
            if (!active() || !scope.active()) return;
            var phase = source.phase();
            if (!phase) {
                complete(source.result());
                return;
            }
            transport.send(
                scope,
                {
                    dataType: id === "shura" ? "jsonp" : "json",
                    timeout: id === "ottclub" ? 30000 : 10000,
                    url: ports.core.operatorGuideUrl(
                        id,
                        String(channelId),
                        {
                            base: base,
                            next: ports.guideNext(),
                            rec: rec,
                            server: config.server,
                        },
                        id === "itv" && current ? "current" : phase
                    ),
                },
                function (data) {
                    if (id === "itv") {
                        try {
                            source.accept(data, phase, 0);
                        } catch (_) {}
                    } else {
                        try {
                            source.accept(data, phase, rec);
                        } catch (_) {
                            complete(null);
                            return;
                        }
                    }
                    source.complete();
                    next();
                },
                function () {
                    source.complete();
                    next();
                }
            );
        }
        next();
    }
    var driver: CatalogProviderDriver = {
        archive: function (channelId, start, end) {
            if (!active()) return "";
            var channel = catalog.channels && catalog.channels[channelId];
            if (!channel) return "";
            var url =
                id === "itv"
                    ? "http://" + channel.server_cdn + "/" + channelId + "/"
                    : driver.stream(channelId);
            return (
                ports.core.providerArchiveUrl(
                    id === "itv"
                        ? "itv"
                        : id === "ottclub"
                          ? "club"
                          : "archive",
                    url,
                    id === "itv" ? "?token=" + channel.token : "",
                    "",
                    Number(start),
                    Number(end),
                    ports.now(),
                    ports.isDune(),
                    id === "itv" ? credentials().mode : 0
                ) || ""
            );
        },
        capabilities: {
            archive: true,
            guide: true,
            media: false,
            settings: true,
        },
        credentials: credentials,
        dispose: function () {
            if (disposed) return;
            disposed = true;
            operation++;
            loads.dispose();
            panels.dispose();
            transport.dispose();
            catalog = helpers.emptyCatalog();
        },
        guide: function (channelId, callback) {
            readGuide(channelId, callback, false);
        },
        id: id,
        load: function (callback) {
            if (!active()) return;
            var version = ++operation;
            var scope = loads.activate("catalog");
            if (!active() || !scope.active() || version !== operation) return;
            catalog = helpers.emptyCatalog();
            var config = credentials();
            var finished = false;
            function complete(error?: string) {
                if (!finished && active() && scope.active()) {
                    finished = true;
                    callback(helpers.snapshot(catalog), error);
                }
            }
            if (
                id === "itv" &&
                !ports.core.operatorCredentialsValid(id, config.username, "")
            ) {
                complete("catalog-credentials");
                return;
            }
            function categories(error?: string) {
                if (!active() || !scope.active()) return;
                var plan = new ports.core.OperatorPlaylistClient(
                    ports.core.operatorProfileUrl("shura", "categories", {}),
                    ports.relay,
                    false,
                    "shura",
                    encodeURIComponent
                );
                function next() {
                    if (!active() || !scope.active()) return;
                    var request = plan.request();
                    if (!request) {
                        complete(error);
                        return;
                    }
                    transport.send(
                        scope,
                        request,
                        function (text) {
                            plan.accept();
                            try {
                                var groups = ports.core.parseOperatorPlaylist(
                                    text,
                                    "shura",
                                    function () {
                                        return 0;
                                    },
                                    Object.keys(catalog.channels)
                                );
                                catalog.groups = groups.groups;
                                catalog.groupOrder = groups.groupOrder;
                                groups.entries.forEach(function (entry: any) {
                                    catalog.channels[entry.id].category =
                                        entry.channel.category;
                                });
                            } catch (_) {}
                            complete(error);
                        },
                        function () {
                            plan.reject();
                            next();
                        }
                    );
                }
                next();
            }
            var request: DriverHttpRequest =
                id === "itv"
                    ? {
                          dataType: "json",
                          timeout: 30000,
                          url: base + "data/" + config.username,
                      }
                    : id === "ottclub"
                      ? {
                            dataType: "text",
                            url: "http://" + config.server + "/api/channel_now",
                        }
                      : {
                            data: { type: "jsonp", uid: "shxxxxxxxxxxx" },
                            dataType: "jsonp",
                            timeout: 10000,
                            url: ports.core.operatorProfileUrl(
                                "shura",
                                "account",
                                {}
                            ),
                        };
            transport.send(
                scope,
                request,
                function (response) {
                    var reducer = new ports.core.OperatorCatalogClient(id);
                    if (id === "ottclub") {
                        var error: string | undefined;
                        try {
                            reducer.accept(
                                JSON.parse(response),
                                ports.core.operatorClubIds(response)
                            );
                            catalog = reducer.result();
                        } catch (_) {
                            catalog = helpers.emptyCatalog();
                            error = "catalog-processing";
                        }
                        complete(error);
                    } else {
                        try {
                            reducer.accept(response, []);
                        } catch (_) {
                            catalog = helpers.emptyCatalog();
                            if (id === "shura")
                                categories("catalog-processing");
                            else complete("catalog-processing");
                            return;
                        }
                        catalog = reducer.result();
                        if (id === "shura") categories();
                        else complete();
                    }
                },
                function () {
                    if (id === "shura") categories();
                    else complete("catalog-network");
                }
            );
        },
        logo: function (channelId) {
            if (!active()) return "";
            var config = credentials();
            if (id === "itv") return base + "icon/" + channelId;
            if (id === "shura")
                return (
                    "http://s" +
                    config.server +
                    ".tvshka.net:81/picon/" +
                    channelId +
                    ".png"
                );
            var channel = catalog.channels && catalog.channels[channelId];
            return channel && channel.img
                ? "http://" + config.server + "/images/" + channel.img
                : "";
        },
        saveCredentials: function (value) {
            if (!active()) return;
            var version = ++operation;
            var previous = credentials();
            if (
                value.server !== previous.server ||
                value.username !== previous.username
            ) {
                loads.dispose();
                if (!active() || version !== operation) return;
                panels.dispose();
                if (!active() || version !== operation) return;
                // Shura/OTTCLUB catalogs are public; changing the playback credential
                // must retain the selected channel for the settings panel's replay.
                if (
                    id === "itv" ||
                    (id === "ottclub" && value.server !== previous.server)
                )
                    catalog = helpers.emptyCatalog();
            }
            ports.storage.set(
                id === "ottclub" ? "ottkey" : "key",
                value.username
            );
            if (id !== "itv")
                ports.storage.set(
                    id === "ottclub" ? "ottwww" : "server",
                    value.server
                );
            if (id !== "ottclub" && value.mode !== undefined)
                ports.storage.set("mpeg", String(value.mode));
        },
        stream: function (channelId) {
            return active() && catalog.channels && catalog.channels[channelId]
                ? ports.core.operatorLiveUrl(
                      id,
                      String(channelId),
                      catalog.channels[channelId],
                      options()
                  )
                : "";
        },
    };
    if (id !== "ottclub")
        driver.guideCurrent = function (channelId, callback) {
            readGuide(channelId, callback, true);
        };
    if (id === "itv")
        driver.subscription = function (callback) {
            if (!active()) return function () {};
            var scope = panels.activate("subscription");
            if (!active() || !scope.active()) return function () {};
            transport.send(
                scope,
                {
                    dataType: "json",
                    timeout: 30000,
                    url: base + "data/" + credentials().username,
                },
                function (data) {
                    callback({ data: data });
                },
                function (xhr, status, error) {
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

function reportCatalogProviderLoad(
    host: any,
    driver: CatalogProviderDriver,
    error?: string
): void {
    if (error && error !== "catalog-credentials")
        host.alert(host._("Failed to load channel list!"));
    var value = driver.credentials();
    if (
        !host.OttPlayCore.operatorCredentialsValid(
            driver.id,
            value.username,
            value.server
        )
    ) {
        host.popupList(
            host.popupActions.indexOf(host.toggleProviderSettingsVisibility) + 1
        );
        host.infoBox(
            driver.id === "itv"
                ? host._(
                      "Enter an application access key (%1–%2 characters).",
                      10,
                      12
                  )
                : driver.id === "ottclub"
                  ? host._("Access key is required!") +
                    "<br>" +
                    host._("Enter playlist URL")
                  : host._("Access key is required!")
        );
    }
}

/** Retained menu/HTML presentation. The driver owns every request and credential. */
function mountCatalogProviderSettings(
    host: any,
    driver: CatalogProviderDriver,
    owner: DriverLifetime,
    storage: DriverStorage
): void {
    var id = driver.id;
    var modes =
        id === "itv" ? ["HLS(a)", "MPEGTS", "HLS(v)"] : ["HLS", "MPEGTS"];
    function keyMessage() {
        return id === "itv"
            ? host._(
                  "Enter an application access key (%1–%2 characters).",
                  10,
                  12
              )
            : host._("Access key is required!");
    }
    var editor = 0;
    function replay() {
        host.playChannel(host.catIndex, host.primaryIndex);
    }
    function edit(
        field: "username" | "server",
        caption: string,
        keyboard: number[],
        effect: () => void
    ) {
        if (!owner.active()) return;
        var revision = ++editor;
        host.editCaption = caption;
        host.editvar = driver.credentials()[field];
        host.setEdit = function () {
            if (!owner.active() || revision !== editor) return;
            var next = driver.credentials();
            var value = String(host.editvar);
            if (id !== "shura" && next[field] === value) return;
            if (
                field === "username" &&
                ((id === "itv" && (value.length < 10 || value.length > 12)) ||
                    (id === "shura" && value && value.length < 8))
            ) {
                host.alert(keyMessage());
                if (id === "shura") {
                    var release = function () {};
                    var timer = host.setTimeout(function () {
                        release();
                        if (owner.active() && revision === editor)
                            host.showEditKey(keyboard);
                    }, 0);
                    release = owner.own(function () {
                        host.clearTimeout(timer);
                    });
                } else host.showEditKey(keyboard);
                return;
            }
            next[field] = value;
            driver.saveCredentials(next);
            if (!owner.active() || revision !== editor) return;
            editor++;
            effect();
        };
        host.showEditKey(keyboard);
    }
    function editAddress() {
        edit(
            "server",
            id === "shura"
                ? host._("Enter server number (%1).", "1, 2, 3, 5")
                : host._("Enter playlist URL"),
            id === "shura" ? [0] : [0, 2],
            id === "shura" ? replay : host.restart
        );
    }
    function editKey() {
        edit(
            "username",
            host._("Edit access key") +
                (id === "itv" ? "<br>" + keyMessage() : ""),
            id === "shura" ? [0, 1, 2] : [0, 1],
            id === "itv" ? host.restart : replay
        );
    }
    function modeLabel() {
        return host._("Stream type: %1", modes[driver.credentials().mode || 0]);
    }
    function changeMode() {
        if (!owner.active()) return;
        var revision = editor;
        var next = driver.credentials();
        next.mode = (next.mode || 0) + 1;
        if (next.mode === modes.length) next.mode = 0;
        driver.saveCredentials(next);
        if (!owner.active() || revision !== editor) return;
        host.popupArray[host.popupActions.indexOf(changeMode)] = modeLabel();
        if (id === "shura") host.popupList(changeMode);
        else {
            try {
                host.listArray[host.selIndex].name = modeLabel();
            } catch (_) {}
            host.showPage();
        }
        if (!host.playType) replay();
        else if (host.playType > 0)
            host.playArchive(host.playType + host.playTime);
    }
    (changeMode as any).menuTitle = modeLabel;
    (changeMode as any).menuDetail = function () {
        return host._("Select a stream type:<br>%1", modes.join(", "));
    };
    (editAddress as any).menuDetail = function () {
        return id === "shura"
            ? host._("Enter server number (%1).", "1, 2, 3, 5")
            : host._(
                  "Enter a playlist URL. The player will restart after saving."
              );
    };
    (editKey as any).menuDetail = keyMessage;
    var closePanel = function () {};
    function subscription() {
        if (!owner.active() || !driver.subscription) return;
        closePanel();
        var visible = true;
        var cancel = function () {};
        var release = function () {};
        function close() {
            if (!visible) return;
            visible = false;
            cancel();
            release();
            if (host.aboutKeyHandler === handler) host.$("#listAbout").hide();
        }
        function handler() {
            if (!owner.active() || host.aboutKeyHandler !== handler)
                return false;
            close();
            return true;
        }
        closePanel = close;
        host.aboutKeyHandler = handler;
        host.$("#listAbout").html(host._("Loading. Please wait...")).show();
        release = owner.own(close);
        cancel = driver.subscription(function (result) {
            if (!visible || !owner.active()) return;
            if (host.aboutKeyHandler !== handler) {
                close();
                return;
            }
            function escape(value: any) {
                return String(value)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#39;");
            }
            if (result.error) {
                host.$("#listAbout").html(host._("Failed to load!"));
            } else if (result.data !== null && result.data !== undefined) {
                var packages: string[] = [];
                try {
                    result.data.package_info.forEach(function (row: any) {
                        packages.push(escape(row.name));
                    });
                } catch (_) {}
                var user = result.data.user_info || {};
                host.$("#listAbout").html(
                    host._("Subscription information") +
                        ":<br/><br/>" +
                        host._("Login") +
                        ": " +
                        escape(user.login || "") +
                        "<br/>" +
                        host._("Balance, $") +
                        ": " +
                        escape(user.cash || "") +
                        "<br/>" +
                        host._("Payment method") +
                        ": " +
                        (["", host._("Prepaid"), host._("Postpaid")][
                            user.pay_system || 0
                        ] || "") +
                        "<br/>" +
                        host._("Packages") +
                        ": " +
                        packages.join(", ")
                );
            }
        });
    }
    if (id === "itv") {
        host.parental =
            /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults|Взрослый/i;
        host.getProviderParams = function () {
            if (!owner.active()) return "";
            var value = driver.credentials().username;
            try {
                host.$("#itvkey").val(value);
            } catch (_) {}
            if (!host.OttPlayCore.operatorCredentialsValid(id, value, ""))
                host.alert(keyMessage());
            return value;
        };
        host.setProviderParams = function () {
            if (!owner.active()) return false;
            var next = driver.credentials();
            var previous = next.username;
            next.username = decodeURIComponent(host.$("#itvkey").val().trim());
            driver.saveCredentials(next);
            if (!owner.active()) return false;
            if (
                !host.OttPlayCore.operatorCredentialsValid(
                    id,
                    next.username,
                    ""
                )
            )
                host.alert(keyMessage());
            return previous !== next.username;
        };
    }
    host.duneAddSettings = function (index: number) {
        if (!owner.active()) return;
        if (
            id !== "ottclub" &&
            isNaN(parseInt(storage.get("sShowArchive") || "", 10))
        )
            storage.set("sShowArchive", "1");
        if (
            id === "itv" &&
            isNaN(parseInt(storage.get("mpeg") || "", 10)) &&
            host.navigator.userAgent.indexOf("Tizen") !== -1
        )
            storage.set("mpeg", "2");
        if (id === "ottclub" && typeof host.delPopup === "function")
            host.delPopup(host.restart);
        var titles =
            id === "itv"
                ? ["Access key", modeLabel(), "Subscription information"]
                : id === "ottclub"
                  ? ["Playlist URL", "Access key"]
                  : ["Server", "Access key", modeLabel()];
        var details =
            id === "itv"
                ? [keyMessage(), (changeMode as any).menuDetail(), ""]
                : id === "ottclub"
                  ? [(editAddress as any).menuDetail(), keyMessage()]
                  : [
                        (editAddress as any).menuDetail(),
                        keyMessage(),
                        (changeMode as any).menuDetail(),
                    ];
        var actions =
            id === "itv"
                ? [editKey, changeMode, subscription]
                : id === "ottclub"
                  ? [editAddress, editKey]
                  : [editAddress, editKey, changeMode];
        host.popupArray.splice.apply(
            host.popupArray,
            ([index, 0] as any[]).concat(titles)
        );
        host.popupDetail.splice.apply(
            host.popupDetail,
            ([index, 0] as any[]).concat(details)
        );
        host.popupActions.splice.apply(
            host.popupActions,
            ([index, 0] as any[]).concat(actions)
        );
    };
}

(window as any).__ottCatalogDrivers = {
    create: createCatalogProviderDriver,
    mountSettings: mountCatalogProviderSettings,
    reportLoad: reportCatalogProviderLoad,
};
// OTTPLAY_FULL_ONLY_END
