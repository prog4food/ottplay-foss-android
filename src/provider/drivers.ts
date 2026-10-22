/** Provider instances receive ports; they never evaluate scripts or use player globals. */
interface DriverLifetime {
    active(): boolean;
    own(cleanup: () => void): () => void;
}
interface DriverStorage {
    get(key: string): string | null;
    remove(key: string): void;
    set(key: string, value: string): void;
}
interface DriverCatalog {
    channels: { [id: string]: any };
    epg?: { [id: string]: any };
    groupOrder: string[];
    groups: { [name: string]: Array<string | number> };
    ids: Array<string | number>;
    incremental?: boolean;
    selectedId?: string | number;
    selectionMissing?: boolean;
}
interface DriverHttpRequest {
    contentType?: string;
    data?: any;
    dataType?: string;
    headers?: Record<string, string>;
    method?: string;
    timeout?: number;
    type?: string;
    url: string;
}
interface ProviderDriverProfile {
    id: string;
    kind: string;
    prefix: string;
    title: string;
}
interface ProviderDriverPorts {
    catalogProgress?(scanned: number, items: number, total?: number): void;
    channelCatalog?(
        rows: any[],
        hash: (value: string) => number,
        profile: string
    ): DriverCatalog;
    commit(
        writes: any[],
        current: () => boolean,
        rollbackAllowed: () => boolean
    ): boolean;
    core: any;
    createLifetime(): any;
    decodeXml?(text: string, profile?: string): any;
    deviceMac?(): string;
    guideNext(): number;
    hash(value: string): number;
    intercept?: (url: string) => void;
    isDune(): boolean;
    language?(): string;
    location?(): string;
    m3u?: {
        crossOrigin(): boolean;
        hashText(value: string): number;
        hashUrl(value: string): number;
        native(): boolean;
        originHost(): string;
        readFile?: (path: string) => string;
        scopedKeys(): string[];
        stripHttp(value: string): string;
    };
    murmur?(value: string, seed: number): number;
    now(): number;
    progress(message: string): void;
    relay: string;
    replaceLocation?: (value: string) => void;
    request(
        request: DriverHttpRequest,
        done: (value: any) => void,
        fail: (...args: any[]) => void
    ): () => void;
    scheme?(): string;
    sourceIdentity?(): string;
    storage: DriverStorage;
    storageFor?(prefix: string): DriverStorage;
    translate(value: string): string;
    userAgent?(): string;
    validateUrl(value: string): boolean;
}
interface ProviderCredentials {
    mode?: number;
    password: string;
    playlist?: string;
    server: string;
    username: string;
}
interface ProviderDriver {
    archive(id: string | number, start: number, end: number): string;
    bootstrap?(): void;
    readonly capabilities: {
        archive: boolean;
        guide: boolean;
        settings: boolean;
        media: boolean;
        /** Finite provider media projected into the ordinary channel list. */
        mediaPlaylist?: boolean;
        libraryOnly?: boolean;
    };
    configuration?(): any;
    credentials(): ProviderCredentials;
    dispose(): void;
    guide(id: string | number, callback: (value: any) => void): void;
    guideCurrent?(id: string | number, callback: (value: any) => void): void;
    readonly id: string;
    libraryReady?(): boolean;
    load(
        callback: (
            catalog: DriverCatalog | null,
            error?: string,
            pending?: boolean
        ) => void
    ): void;
    logo(id: string | number): string;
    resolveStream?(
        url: string,
        callback: (url: string | null) => void
    ): () => void;
    saveConfiguration?(value: any): boolean;
    saveCredentials(value: ProviderCredentials): boolean | void;
    storageKey?(key: string): string;
    stream(id: string | number): string;
    subscription?(callback: (value: any) => void): () => void;
}
type ProviderDriverFactory = (
    ports: ProviderDriverPorts,
    lifetime: DriverLifetime
) => ProviderDriver;

function emptyDriverCatalog(): DriverCatalog {
    return {
        channels: Object.create(null),
        groupOrder: [],
        groups: Object.create(null),
        ids: [],
    };
}

function driverCatalogSnapshot(catalog: DriverCatalog): DriverCatalog {
    var snapshot = emptyDriverCatalog();
    snapshot.ids = catalog.ids.slice();
    snapshot.groupOrder = catalog.groupOrder.slice();
    Object.keys(catalog.groups).forEach(function (name) {
        snapshot.groups[name] = catalog.groups[name].slice();
    });
    function detach(value: any): any {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(detach);
        var result: any = {};
        var keys = Object.keys(value);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var child = detach(value[key]);
            if (key in result) {
                Object.defineProperty(result, key, {
                    configurable: true,
                    enumerable: true,
                    value: child,
                    writable: true,
                });
            } else result[key] = child;
        }
        return result;
    }
    snapshot.channels = detach(catalog.channels);
    if (catalog.epg) snapshot.epg = detach(catalog.epg);
    return snapshot;
}

function createDriverRegistry() {
    var factories: { [id: string]: ProviderDriverFactory } =
        Object.create(null);
    return {
        create: function (
            id: string,
            ports: ProviderDriverPorts,
            lifetime: DriverLifetime
        ): ProviderDriver {
            if (!factories[id])
                throw new Error("Unsupported provider driver: " + id);
            return factories[id](ports, lifetime);
        },
        has: function (id: string) {
            return !!factories[id];
        },
        ids: function () {
            return Object.keys(factories);
        },
        register: function (id: string, factory: ProviderDriverFactory) {
            if (!id || factories[id])
                throw new Error("Duplicate provider driver: " + id);
            factories[id] = factory;
        },
    };
}

function createOfflineDriver(
    ports: ProviderDriverPorts,
    owner: DriverLifetime
): ProviderDriver {
    var disposed = false;
    var catalog = emptyDriverCatalog();
    var revision = 0;
    var loadTimer: any = null;
    var loadingOwner: any = null;
    function closeLoading(): void {
        var current = loadingOwner;
        loadingOwner = null;
        if (current) current.close();
    }
    function clearLoadTimer(): void {
        if (
            loadTimer !== null &&
            typeof (window as any).clearTimeout === "function"
        )
            (window as any).clearTimeout(loadTimer);
        loadTimer = null;
    }
    function active(): boolean {
        return !disposed && owner.active();
    }
    var driver: ProviderDriver = {
        archive: function () {
            return "";
        },
        capabilities: {
            archive: false,
            guide: false,
            media: false,
            settings: false,
        },
        credentials: function () {
            return { password: "", server: "", username: "" };
        },
        dispose: function () {
            disposed = true;
            revision++;
            clearLoadTimer();
            closeLoading();
        },
        guide: function (_, done) {
            if (active()) done([]);
        },
        id: "offline",
        load: function (done) {
            var request = ++revision;
            clearLoadTimer();
            closeLoading();
            var media = (window as any).__ottLocalMedia;
            if (!media) {
                done(emptyDriverCatalog(), "Local media is unavailable");
                return;
            }
            var profiles = (window as any).__ottOfflineProfiles;
            var profileBefore = "";
            var profileCurrent: (() => boolean) | null = null;
            try {
                profileBefore = profiles ? JSON.stringify(profiles.read()) : "";
                if (profiles)
                    profileCurrent = profiles.catalogGuard
                        ? profiles.catalogGuard()
                        : function () {
                              return (
                                  JSON.stringify(profiles.read()) ===
                                  profileBefore
                              );
                          };
            } catch (_) {
                done(
                    emptyDriverCatalog(),
                    "Local profile configuration is unavailable"
                );
                return;
            }
            var started = false;
            var progressStamp = "";
            var wanted = "";
            var waitForFinal = false;
            var missingPreferred = false;
            var legacyIndex = 0;
            try {
                var imported = media.takeImportSelection
                    ? media.takeImportSelection()
                    : "";
                var host = window as any;
                var source =
                    host.__ottSourceIdentity &&
                    host.__ottSourceIdentity.current(host);
                var saved = JSON.parse(
                    ports.storage.get("channelLibrary:" + source) || "null"
                );
                var profileSelection =
                    profiles && profiles.selection
                        ? profiles.selection()
                        : null;
                if (profileSelection !== null) {
                    wanted = profileSelection || "local-profile-unbound";
                } else if (imported) {
                    wanted = imported;
                } else if (saved && saved.selected && saved.selected.itemId) {
                    wanted = String(saved.selected.itemId).replace(
                        /^channel:/,
                        ""
                    );
                    if (wanted.indexOf("local-") !== 0) waitForFinal = true;
                } else {
                    var savedIndex = ports.storage.get("primaryIndex");
                    legacyIndex =
                        savedIndex == null || savedIndex === ""
                            ? 0
                            : Number(savedIndex);
                    waitForFinal =
                        !isFinite(legacyIndex) ||
                        legacyIndex < 0 ||
                        Math.floor(legacyIndex) !== legacyIndex;
                }
            } catch (_) {
                waitForFinal = true;
            }
            catalog = emptyDriverCatalog();
            function current(): boolean {
                return active() && request === revision;
            }
            function recover(error: string, offerRecovery = true): void {
                if (!current()) return;
                clearLoadTimer();
                revision++;
                closeLoading();
                if (!started) {
                    done(emptyDriverCatalog(), error);
                    if (
                        offerRecovery &&
                        active() &&
                        request + 1 === revision &&
                        typeof media.resume === "function"
                    )
                        media.resume(true, error);
                }
            }
            function heartbeat(timeout = 60000): void {
                clearLoadTimer();
                if (typeof (window as any).setTimeout === "function")
                    loadTimer = (window as any).setTimeout(function () {
                        recover("Local source did not respond");
                    }, timeout);
            }
            function publish(value: any, final: boolean): boolean {
                if (!current()) return false;
                ensureLoadingControls();
                if (!value || !Array.isArray(value.items)) {
                    recover("Invalid local media catalog", false);
                    return false;
                }
                if (value.cancelled) {
                    recover("Local catalog scan was cancelled", false);
                    return false;
                }
                try {
                    if (profiles) {
                        if (profileCurrent && !profileCurrent()) {
                            recover(
                                "Local profile changed while loading",
                                false
                            );
                            return false;
                        }
                        value = profiles.filter(value);
                    }
                } catch (_) {
                    recover(
                        "Local profile configuration is unavailable",
                        false
                    );
                    return false;
                }
                if (final && value.scanning) {
                    recover("Local catalog scan is incomplete", false);
                    return false;
                }
                var stamp = [
                    value.scanned || 0,
                    (value.items || []).length,
                    value.phase || "",
                    !!value.scanning,
                ].join(":");
                // Polling the same stalled native scan is not progress.
                if (stamp !== progressStamp) {
                    progressStamp = stamp;
                    heartbeat(
                        media.progressTimeout
                            ? media.progressTimeout(value)
                            : 60000
                    );
                }
                (value.items || []).forEach(function (item: any) {
                    if (item.available === false || !item.url) return;
                    var id = "local-" + item.id;
                    if (catalog.channels[id]) return;
                    catalog.ids.push(id);
                    var parts = String(item.name || "").split("/");
                    var source = (value.sources || []).filter(function (
                        entry: any
                    ) {
                        return entry.id === item.sourceId;
                    })[0];
                    catalog.channels[id] = {
                        __ottLocalSource:
                            source && source.kind === "folder" ? source.id : "",
                        __ottLocalSourceName:
                            source && source.kind === "folder"
                                ? source.name
                                : "",
                        __ottMediaCollection:
                            item.directory ||
                            (parts.length > 1 ? parts[parts.length - 2] : "") ||
                            (source && source.kind === "folder"
                                ? source.name
                                : ""),
                        category: {
                            class: 2,
                            name: ports.translate("Local videos"),
                        },
                        channel_name: parts[parts.length - 1],
                        logo: "",
                        rec: 0,
                        time: 0,
                        time_to: 0,
                        url: item.url,
                    };
                });
                if (
                    !started &&
                    typeof document !== "undefined" &&
                    document.createElement
                ) {
                    var panel = document.getElementById("dialogbox");
                    if (panel && panel.querySelector(".ott-spinner")) {
                        var progress = panel.querySelector(
                            "[data-local-scanned]"
                        );
                        if (!progress) {
                            progress = document.createElement("div");
                            panel.appendChild(progress);
                        }
                        var scanned = Math.max(
                            0,
                            Math.floor(Number(value.scanned) || 0)
                        );
                        if (!isFinite(scanned)) scanned = 0;
                        var waiting = waitForFinal
                            ? "invalid-index"
                            : wanted &&
                                !catalog.channels[wanted] &&
                                !missingPreferred
                              ? "saved-id"
                              : catalog.ids.length <= legacyIndex &&
                                  legacyIndex > 0
                                ? "legacy-index"
                                : !catalog.ids.length
                                  ? "no-items"
                                  : "ready";
                        progress.setAttribute(
                            "data-local-scanned",
                            String(scanned)
                        );
                        progress.setAttribute(
                            "data-local-items",
                            String(catalog.ids.length)
                        );
                        progress.setAttribute("data-local-waiting", waiting);
                        progress.setAttribute(
                            "data-local-phase",
                            value.phase || "files"
                        );
                        progress.textContent = media.progressText
                            ? media.progressText(value)
                            : ports.translate("Local videos") +
                              ": " +
                              catalog.ids.length;
                    }
                }
                if (final) clearLoadTimer();
                if (
                    wanted.indexOf("local-") === 0 &&
                    value.preferred &&
                    value.preferred.id === wanted.slice(6) &&
                    value.preferred.state === "missing"
                )
                    missingPreferred = true;
                if (
                    !started &&
                    !final &&
                    (!catalog.ids.length ||
                        waitForFinal ||
                        catalog.ids.length <= legacyIndex ||
                        (wanted &&
                            !catalog.channels[wanted] &&
                            !missingPreferred))
                )
                    return true;
                var incremental = started;
                started = true;
                closeLoading();
                var snapshot = driverCatalogSnapshot(catalog);
                snapshot.incremental = incremental;
                if (missingPreferred && !catalog.channels[wanted])
                    snapshot.selectedId = catalog.ids[0];
                done(snapshot, undefined, incremental);
                if (!current()) return false;
                try {
                    if (profileCurrent && !profileCurrent()) {
                        recover("Local profile changed while loading", false);
                        return false;
                    }
                } catch (_) {
                    recover(
                        "Local profile configuration is unavailable",
                        false
                    );
                    return false;
                }
                if (
                    final &&
                    !catalog.ids.length &&
                    typeof media.open === "function"
                ) {
                    if (
                        value.sources &&
                        value.sources.length &&
                        typeof media.resume === "function"
                    )
                        media.resume(
                            true,
                            media.failureMessage
                                ? media.failureMessage(value)
                                : ""
                        );
                    else media.open();
                }
                return true;
            }
            function cancelStartup(): void {
                var host = window as any;
                if (!current() || started || host.__ottKiosk?.locked()) return;
                if (typeof media.cancelScan === "function") media.cancelScan();
                recover("");
            }
            function ensureLoadingControls(): void {
                var host = window as any;
                var panel =
                    typeof document !== "undefined" &&
                    document.getElementById("dialogbox");
                if (
                    !current() ||
                    started ||
                    !panel ||
                    !panel.querySelector(".ott-spinner") ||
                    panel.style?.display === "none" ||
                    !host.__ottClassicScreenPort ||
                    typeof host.renderButtonHint !== "function" ||
                    host.__ottKiosk?.locked()
                )
                    return;
                if (
                    !loadingOwner ||
                    (typeof loadingOwner.active === "function" &&
                        !loadingOwner.active())
                ) {
                    loadingOwner = host.__ottClassicScreenPort.setOwnedCallback(
                        "dialog",
                        function (key: number) {
                            if (
                                key === host.keys.RETURN ||
                                key === host.keys.EXIT ||
                                key === host.keys.ENTER
                            )
                                cancelStartup();
                        }
                    ).owner;
                    loadingOwner.model = loadingOwner.model || {};
                    loadingOwner.model.cancelOnPower = cancelStartup;
                }
                // Startup can replace the spinner markup after the first
                // callback; restore its visible action on the next batch.
                if (!panel.querySelector("[data-local-cancel]")) {
                    var cancel = document.createElement("div");
                    cancel.setAttribute("data-local-cancel", "");
                    cancel.innerHTML = host.renderButtonHint(
                        host.keys.RETURN,
                        host.strRETURN,
                        "Cancel"
                    );
                    cancel.onclick = function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelStartup();
                    };
                    panel.appendChild(cancel);
                }
            }
            ensureLoadingControls();
            heartbeat();
            try {
                media
                    .list(
                        function (value: any) {
                            return publish(value, false);
                        },
                        wanted.indexOf("local-") === 0
                            ? wanted.slice(6)
                            : undefined
                    )
                    .then(
                        function (value: any) {
                            publish(value, true);
                        },
                        function (error: any) {
                            recover(String(error.message || error));
                        }
                    );
            } catch (_) {
                recover("Local catalog could not be read");
            }
        },
        logo: function () {
            return "";
        },
        saveCredentials: function () {},
        stream: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].url
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

function createDemoDriver(
    ports: ProviderDriverPorts,
    owner: DriverLifetime
): ProviderDriver {
    var disposed = false;
    var catalog = emptyDriverCatalog();
    var title = ports.translate("Demo — moving test pattern");
    ["pattern.mp4", "pattern.m3u8"].forEach(function (file, index) {
        var id = 900000001 + index;
        catalog.ids.push(id);
        catalog.channels[id] = {
            category: { class: 2, name: "Demo" },
            channel_name: title + (index ? " (HLS)" : " (MP4)"),
            logo: "",
            rec: 0,
            time: 0,
            time_to: 0,
            url: "https://liminal-sketch-vv8r.here.now/demo/" + file,
        };
    });
    function active() {
        return !disposed && owner.active();
    }
    var driver: ProviderDriver = {
        archive: function () {
            return "";
        },
        capabilities: {
            archive: false,
            guide: true,
            media: false,
            settings: false,
        },
        credentials: function () {
            return { password: "", server: "", username: "" };
        },
        dispose: function () {
            disposed = true;
        },
        guide: function (_, callback) {
            if (active()) callback([]);
        },
        id: "demo",
        load: function (callback) {
            if (active()) callback(driverCatalogSnapshot(catalog));
        },
        logo: function () {
            return "";
        },
        saveCredentials: function () {},
        stream: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].url
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

function createDriverTransport(
    ports: ProviderDriverPorts,
    owner: DriverLifetime,
    active: () => boolean
) {
    var requests: Array<() => void> = [];
    function request(
        scope: DriverLifetime,
        options: DriverHttpRequest,
        done: (value: any) => void,
        fail: (...args: any[]) => void
    ) {
        if (!active() || !scope.active()) return;
        var settled = false;
        var release = function () {};
        var releaseOwner = function () {};
        function finish(callback: () => void) {
            if (settled) return;
            settled = true;
            release();
            releaseOwner();
            var index = requests.indexOf(cleanup);
            if (index !== -1) requests.splice(index, 1);
            if (active() && scope.active()) callback();
        }
        var cleanup = function () {};
        var abort = ports.request(
            options,
            function (value) {
                finish(function () {
                    done(value);
                });
            },
            function () {
                var args = arguments;
                finish(function () {
                    fail.apply(null, args as any);
                });
            }
        );
        if (!settled) {
            cleanup = function () {
                if (!settled) {
                    settled = true;
                    release();
                    releaseOwner();
                    var index = requests.indexOf(cleanup);
                    if (index !== -1) requests.splice(index, 1);
                    abort();
                }
            };
            requests.push(cleanup);
            release = scope.own(cleanup);
            if (!settled) releaseOwner = owner.own(cleanup);
        }
    }
    return {
        dispose: function () {
            requests.slice().forEach(function (cancel) {
                cancel();
            });
            requests = [];
        },
        send: request,
    };
}

var credentialBusy = false;
var credentialPending: (() => void) | null = null;

/** Serialize credential writes against reentrant loads, preserving the latest intent. */
function createCredentialOperations(
    ports: ProviderDriverPorts,
    active: () => boolean
) {
    var revision = 0;
    return {
        run: function (
            action: (current: () => boolean) => any,
            saving?: boolean
        ): any {
            var operation = ++revision;
            var result: any = false;
            function current() {
                return active() && operation === revision;
            }
            if (credentialBusy) {
                credentialPending = saving
                    ? null
                    : function () {
                          if (current()) action(current);
                      };
                return false;
            }
            if (!saving) return current() ? action(current) : false;
            credentialBusy = true;
            try {
                if (current()) result = action(current);
            } catch (error) {
                credentialPending = null;
                throw error;
            } finally {
                credentialBusy = false;
            }
            var next = credentialPending;
            credentialPending = null;
            if (next) next();
            return result;
        },
        write: function (
            values: { [key: string]: string },
            current: () => boolean
        ): boolean {
            var writes = Object.keys(values).map(function (key) {
                return {
                    after: values[key],
                    before: ports.storage.get(key),
                    key: key,
                };
            });
            return (
                ports.commit(writes, current, function () {
                    return credentialBusy;
                }) && current()
            );
        },
    };
}

function createXtreamDriver(
    ports: ProviderDriverPorts,
    owner: DriverLifetime
): ProviderDriver {
    var disposed = false;
    var catalog = emptyDriverCatalog();
    var loads = ports.createLifetime();
    function active() {
        return !disposed && owner.active();
    }
    var operations = createCredentialOperations(ports, active);
    var transport = createDriverTransport(ports, owner, active);
    function credentials(): ProviderCredentials {
        var value: any;
        try {
            value = JSON.parse(ports.storage.get("xtream_data") || "null");
        } catch (_) {}
        return value && value.server
            ? {
                  password: String(value.password || ""),
                  server: String(value.server),
                  username: String(value.username || ""),
              }
            : { password: "", server: "", username: "" };
    }
    function client(value: ProviderCredentials) {
        return ports.core.legacyXtreamClient(
            value.server,
            value.username,
            value.password,
            encodeURIComponent
        );
    }
    var driver: ProviderDriver = {
        archive: function (id, start, end) {
            var row = active() && catalog.channels[id];
            return row
                ? ports.core.providerArchiveUrl(
                      "template",
                      row.url || "",
                      row.caso || "",
                      row.ca || "",
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
        credentials: credentials,
        dispose: function () {
            if (disposed) return;
            disposed = true;
            loads.dispose();
            transport.dispose();
            catalog = emptyDriverCatalog();
        },
        guide: function (id, callback) {
            if (!active()) return;
            var scope = loads.current() || owner;
            var requestedCatalog = catalog;
            var config = credentials();
            if (!scope.active() || requestedCatalog !== catalog) return;
            var channel = requestedCatalog.channels[id];
            if (
                !config.server ||
                !config.username ||
                !config.password ||
                !channel ||
                !channel.epg
            ) {
                callback(null);
                return;
            }
            var source = client(config);
            transport.send(
                scope,
                {
                    dataType: "json",
                    timeout: 10000,
                    type: "GET",
                    url: source.shortEpgUrl(String(channel.epg)),
                },
                function (response) {
                    callback(
                        source.guide(response, function (value: any) {
                            return new Date(value).getTime() / 1000;
                        })
                    );
                },
                function () {
                    callback(null);
                }
            );
        },
        id: "xtream",
        load: function (callback) {
            return operations.run(function (current) {
                if (!active()) return;
                var scope = loads.activate("catalog");

                if (!current() || !scope.active()) return;
                catalog = emptyDriverCatalog();
                var config = credentials();
                if (!current()) return;
                if (
                    !config.server ||
                    !config.username ||
                    !config.password ||
                    !ports.validateUrl(config.server)
                ) {
                    callback(null, "credentials");
                    return;
                }
                var source = client(config);
                transport.send(
                    scope,
                    {
                        dataType: "json",
                        timeout: 15000,
                        type: "GET",
                        url: source.request(),
                    },
                    function (response) {
                        var error = source.accept(response)
                            ? "catalog"
                            : undefined;
                        var next = error
                            ? emptyDriverCatalog()
                            : ports.channelCatalog!(
                                  source.channelCatalog(),
                                  ports.hash,
                                  "xtream"
                              );
                        if (!scope.active()) return;
                        catalog = next;
                        callback(driverCatalogSnapshot(catalog), error);
                    },
                    function () {
                        callback(driverCatalogSnapshot(catalog), "network");
                    }
                );
            });
        },
        logo: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].logo || ""
                : "";
        },
        saveCredentials: function (value) {
            return operations.run(function (current) {
                if (!active()) return;
                loads.dispose();
                if (!current()) return false;
                catalog = emptyDriverCatalog();
                return operations.write(
                    {
                        xtream_data: JSON.stringify({
                            data: null,
                            password: value.password,
                            server: value.server,
                            username: value.username,
                        }),
                    },
                    current
                );
            }, true);
        },
        stream: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].url || ""
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

// OTTPLAY_FULL_ONLY_BEGIN
function createOperatorDriver(
    profile: ProviderDriverProfile,
    ports: ProviderDriverPorts,
    owner: DriverLifetime
): ProviderDriver {
    var disposed = false;
    var catalog = emptyDriverCatalog();
    var config: any = {};
    var loads = ports.createLifetime();
    function active() {
        return !disposed && owner.active();
    }
    var operations = createCredentialOperations(ports, active);
    var transport = createDriverTransport(ports, owner, active);
    function readConfiguration(): any {
        var value: any;
        try {
            value = JSON.parse(ports.storage.get("cfg") || "null");
        } catch (_) {}
        return value && (value.server || value.m3u)
            ? value
            : { m3u: "", pass: "", server: "", user: "" };
    }
    function credentials(): ProviderCredentials {
        var value = readConfiguration();
        return {
            password: String(value.pass || ""),
            playlist: String(value.m3u || ""),
            server: String(value.server || ""),
            username: String(value.user || ""),
        };
    }
    var driver: ProviderDriver = {
        archive: function () {
            return "";
        },
        capabilities: {
            archive: false,
            guide: false,
            media: false,
            settings: true,
        },
        configuration: function () {
            var copy: any = {};
            Object.keys(config).forEach(function (key) {
                copy[key] = config[key];
            });
            return copy;
        },
        credentials: credentials,
        dispose: function () {
            if (disposed) return;
            disposed = true;
            loads.dispose();
            transport.dispose();
            catalog = emptyDriverCatalog();
        },
        guide: function (_, callback) {
            if (active()) callback(null);
        },
        id: profile.id,
        load: function (callback) {
            return operations.run(function (current) {
                if (!active()) return;
                var scope = loads.activate("catalog");

                if (!current() || !scope.active()) return;
                catalog = emptyDriverCatalog();
                var loadedConfig = readConfiguration();
                if (!current()) return;
                config = loadedConfig;
                function complete(error?: string, pending?: boolean) {
                    if (active() && scope.active())
                        callback(
                            driverCatalogSnapshot(catalog),
                            error,
                            pending
                        );
                }
                function playlist(url: string) {
                    ports.progress("Loading M3U...");
                    if (!scope.active() || !current()) return;
                    var plan = new ports.core.OperatorPlaylistClient(
                        url,
                        ports.relay,
                        false,
                        "generic",
                        encodeURIComponent
                    );
                    function next() {
                        if (!active() || !scope.active()) return;
                        var request = plan.request();
                        if (!request) {
                            complete();
                            return;
                        }
                        transport.send(
                            scope,
                            request,
                            function (data) {
                                plan.accept();
                                var next = emptyDriverCatalog();
                                try {
                                    next = ports.core.parseProviderPlaylist(
                                        data,
                                        "generic",
                                        ports.hash,
                                        0
                                    );
                                } catch (_) {}
                                if (!scope.active()) return;
                                catalog = next;
                                complete();
                            },
                            function () {
                                plan.reject();
                                if (plan.request()) next();
                                else complete("playlist");
                            }
                        );
                    }
                    next();
                }
                var action = ports.core.operatorSourceAction(loadedConfig);
                if (action === "PLAYLIST") {
                    playlist(loadedConfig.m3u);
                    return;
                }
                if (action !== "API") {
                    complete("configure");
                    return;
                }
                ports.progress("Loading from API...");
                if (!scope.active() || !current()) return;
                if (profile.kind === "xtream-fallback") {
                    var xtream = ports.core.legacyXtreamClient(
                        loadedConfig.server,
                        loadedConfig.user,
                        loadedConfig.pass,
                        encodeURIComponent
                    );
                    transport.send(
                        scope,
                        {
                            dataType: "json",
                            timeout: 15000,
                            type: "GET",
                            url: xtream.request(),
                        },
                        function (response) {
                            if (xtream.accept(response)) {
                                loadedConfig.m3u =
                                    xtream.fallbackPlaylist(false);
                                playlist(loadedConfig.m3u);
                            } else {
                                var next = ports.channelCatalog!(
                                    xtream.channelCatalog(),
                                    ports.hash,
                                    "xtream"
                                );
                                if (!scope.active()) return;
                                catalog = next;
                                complete();
                            }
                        },
                        function () {
                            loadedConfig.m3u = xtream.fallbackPlaylist(true);
                            playlist(loadedConfig.m3u);
                        }
                    );
                    return;
                }
                var session = new ports.core.OperatorChannelClient(
                    loadedConfig,
                    encodeURIComponent
                );
                transport.send(
                    scope,
                    {
                        dataType: "json",
                        timeout: 15000,
                        type: "GET",
                        url: session.request(),
                    },
                    function (response) {
                        try {
                            session.accept(response);
                        } catch (error) {
                            var next = ports.channelCatalog!(
                                session.channelCatalog(),
                                ports.hash,
                                "xtream"
                            );
                            if (scope.active()) catalog = next;
                            complete(undefined, true);
                            throw error;
                        }
                        var next = ports.channelCatalog!(
                            session.channelCatalog(),
                            ports.hash,
                            "xtream"
                        );
                        if (!scope.active()) return;
                        catalog = next;
                        if (session.action() === "PLAYLIST") {
                            loadedConfig.m3u = session.request();
                            playlist(loadedConfig.m3u);
                        } else complete();
                    },
                    function () {
                        session.reject();
                        loadedConfig.m3u = session.request();
                        playlist(loadedConfig.m3u);
                    }
                );
            });
        },
        logo: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].logo || ""
                : "";
        },
        saveCredentials: function (value) {
            return operations.run(function (current) {
                if (!active()) return;
                loads.dispose();
                if (!current()) return false;
                catalog = emptyDriverCatalog();
                var next = readConfiguration();
                next.server = value.server;
                next.user = value.username;
                next.pass = value.password;
                next.m3u = value.playlist || "";
                var committed = operations.write(
                    { cfg: JSON.stringify(next) },
                    current
                );
                if (committed) config = next;
                return committed;
            }, true);
        },
        stream: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].url || ""
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

/** Instance orchestration for account-token and named playlist protocols.
 * Credentials, request plans, IDs and stream policies remain owned by the shared core. */
function createNamedPlaylistDriver(
    profile: ProviderDriverProfile,
    ports: ProviderDriverPorts,
    owner: DriverLifetime
): ProviderDriver {
    var id = profile.id;
    var disposed = false;
    var catalog = emptyDriverCatalog();
    var loads = ports.createLifetime();
    function active() {
        return !disposed && owner.active();
    }
    var operations = createCredentialOperations(ports, active);
    var transport = createDriverTransport(ports, owner, active);
    function credentials(): ProviderCredentials {
        return {
            mode: parseInt(ports.storage.get("ts_hls") || "0", 10) || 0,
            password: ports.storage.get(id === "1ott" ? "pin" : "pass") || "",
            playlist:
                id === "tvteam"
                    ? ports.storage.get("www") || "https://tv.team/pl/11/"
                    : "",
            server: "",
            username:
                ports.storage.get(
                    id === "1ott" ? "id" : id === "only4" ? "token" : "login"
                ) || "",
        };
    }
    function bootstrap() {
        if (!active() || id !== "tvteam") return;
        var href = ports.location ? ports.location() : "";
        var captured = ports.core.operatorCapturedTvteamPlaylist(
            href,
            ports.isDune()
        );
        if (captured) {
            ports.storage.set("www", captured);
            if (ports.replaceLocation)
                ports.replaceLocation(href.split("?")[0]);
        }
    }
    function valid(config: ProviderCredentials) {
        return ports.core.operatorCredentialsValid(
            id,
            id === "tvteam" ? config.playlist : config.username,
            config.password
        );
    }
    var driver: ProviderDriver = {
        archive: function (channelId, start, end) {
            var channel = active() && catalog.channels[channelId];
            return channel
                ? ports.core.providerArchiveUrl(
                      id === "only4"
                          ? "only4"
                          : id === "tvteam"
                            ? "auto-utc-now"
                            : "utc",
                      channel.url,
                      "",
                      "",
                      Number(start),
                      Number(end),
                      ports.now(),
                      ports.isDune(),
                      id === "only4" ? credentials().mode : 0
                  ) || ""
                : "";
        },
        bootstrap: bootstrap,
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
            loads.dispose();
            transport.dispose();
            catalog = emptyDriverCatalog();
        },
        guide: function (channelId, callback) {
            if (!active()) return;
            var channel = catalog.channels[channelId];
            if (id !== "tvteam" && (!channel || !channel.epg)) {
                callback(null);
                return;
            }
            var path =
                id === "1ott"
                    ? encodeURIComponent("propg.net/epg/" + channel.epg)
                    : id + "/epg/" + (channel && channel.epg);
            transport.send(
                loads.current() || owner,
                {
                    dataType: "json",
                    timeout: 10000,
                    url:
                        id === "tvteam"
                            ? "http://tvteam.eu/" + channelId + ".json"
                            : "http://epg.drm-play.com/" + path + ".json",
                },
                function (data) {
                    callback(data === null ? null : data.epg_data);
                },
                function () {
                    callback(null);
                }
            );
        },
        id: id,
        load: function (callback) {
            return operations.run(function (current) {
                if (!active()) return;
                var scope = loads.activate("catalog");

                if (!current() || !scope.active()) return;
                catalog = emptyDriverCatalog();
                bootstrap();
                var config = credentials();
                if (!current()) return;
                function complete(error?: string) {
                    if (active() && scope.active())
                        callback(driverCatalogSnapshot(catalog), error);
                }
                if (!valid(config)) {
                    complete("named-credentials");
                    return;
                }
                function fetchText(url: string, receive: (value: any) => void) {
                    if (!active() || !scope.active()) return;
                    var plan = new ports.core.OperatorPlaylistClient(
                        url,
                        ports.relay,
                        !!ports.intercept,
                        "classic",
                        encodeURIComponent
                    );
                    if (plan.interceptUrl() && ports.intercept)
                        ports.intercept(plan.interceptUrl());
                    function advance() {
                        if (!active() || !scope.active()) return;
                        var request = plan.request();
                        if (!request) {
                            complete();
                            return;
                        }
                        transport.send(
                            scope,
                            request,
                            function (response) {
                                plan.accept();
                                receive(response);
                            },
                            function () {
                                plan.reject();
                                if (plan.request()) {
                                    if (plan.progress()) ports.progress("p...");
                                    advance();
                                } else complete("named-network");
                            }
                        );
                    }
                    advance();
                }
                function receivePlaylist(text: any) {
                    var error: string | undefined;
                    try {
                        var parsed = ports.core.parseOperatorPlaylist(
                            text,
                            id,
                            function () {
                                return 0;
                            },
                            []
                        );
                        parsed.entries.forEach(function (entry: any) {
                            if (entry.generatedName)
                                entry.channel.channel_name = ports.translate(
                                    "??? No channel name"
                                );
                        });
                        if (!scope.active()) return;
                        catalog = parsed;
                        if (parsed.malformed) error = "named-catalog";
                    } catch (_) {
                        error = "named-catalog";
                    }
                    complete(error);
                }
                var parameters = {
                    base: "http://list.1ott.net",
                    id: config.username,
                    login: config.username,
                    password: config.password,
                    pin: config.password,
                    token: config.username,
                    url: config.playlist,
                };
                if (id === "1ott") {
                    fetchText(
                        ports.core.operatorProfileUrl(
                            id,
                            "account",
                            parameters
                        ),
                        function (response) {
                            var token: any;
                            try {
                                token = JSON.parse(response).token;
                            } catch (_) {
                                complete("named-catalog");
                                return;
                            }
                            fetchText(
                                ports.core.operatorProfileUrl(id, "playlist", {
                                    base: parameters.base,
                                    token: token,
                                }),
                                receivePlaylist
                            );
                        }
                    );
                } else
                    fetchText(
                        ports.core.operatorProfileUrl(
                            id,
                            "playlist",
                            parameters
                        ),
                        receivePlaylist
                    );
            });
        },
        logo: function (channelId) {
            return active() && catalog.channels[channelId]
                ? catalog.channels[channelId].logo || ""
                : "";
        },
        saveCredentials: function (value) {
            return operations.run(function (current) {
                if (!active()) return;
                var previous = credentials();
                var accountChanged =
                    id === "tvteam"
                        ? previous.playlist !== value.playlist
                        : previous.username !== value.username ||
                          previous.password !== value.password;
                if (!current()) return false;
                if (accountChanged) {
                    loads.dispose();
                    if (!current()) return false;
                    catalog = emptyDriverCatalog();
                }
                var writes: { [key: string]: string } = {};
                if (id === "tvteam") writes.www = value.playlist || "";
                else {
                    writes[
                        id === "1ott"
                            ? "id"
                            : id === "only4"
                              ? "token"
                              : "login"
                    ] = value.username;
                    if (id !== "only4")
                        writes[id === "1ott" ? "pin" : "pass"] = value.password;
                }
                if (id === "only4" && value.mode !== undefined)
                    writes.ts_hls = String(value.mode);
                return operations.write(writes, current);
            }, true);
        },
        stream: function (channelId) {
            if (!active()) return "";
            if (id === "only4")
                return ports.core.operatorLiveUrl(
                    id,
                    String(channelId),
                    catalog.channels[channelId],
                    { mode: credentials().mode }
                );
            return catalog.channels[channelId]
                ? catalog.channels[channelId].url || ""
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

// OTTPLAY_FULL_ONLY_END

var providerDriverProfiles: ProviderDriverProfile[] = (window as any)
    .__ottProviderDriverProfiles;
var providerDriverRegistry = createDriverRegistry();
providerDriverProfiles.forEach(function (profile) {
    providerDriverRegistry.register(
        profile.id,
        profile.kind === "offline"
            ? createOfflineDriver
            : profile.kind === "demo"
              ? createDemoDriver
              : profile.kind === "xtream"
                ? createXtreamDriver
                : function (ports, owner) {
                      var helpers = {
                          emptyCatalog: emptyDriverCatalog,
                          media: (window as any).__ottMediaCatalog.create,
                          snapshot: driverCatalogSnapshot,
                          transport: createDriverTransport,
                      };
                      if (profile.kind === "stalker")
                          return (window as any).__ottStalkerDriver.create(
                              ports,
                              owner,
                              helpers
                          );
                      if (profile.kind === "m3u")
                          return (window as any).__ottM3uDriver.create(
                              ports,
                              owner,
                              helpers
                          );
                      if (profile.kind === "plex" || profile.kind === "vportal")
                          return (window as any)[
                              profile.kind === "plex"
                                  ? "__ottPlexDriver"
                                  : "__ottVPortalDriver"
                          ].create(ports, owner, {
                              credentials: createCredentialOperations,
                              emptyCatalog: emptyDriverCatalog,
                          });
                      // OTTPLAY_FULL_ONLY_BEGIN
                      if (profile.kind === "catalog")
                          return (window as any).__ottCatalogDrivers.create(
                              profile.id,
                              ports,
                              owner,
                              helpers
                          );
                      if (profile.kind === "playlist")
                          return (window as any).__ottPlaylistDrivers.create(
                              profile.id,
                              ports,
                              owner,
                              helpers
                          );
                      if (profile.kind === "edem")
                          return (window as any).__ottEdemDriver.create(
                              ports,
                              owner,
                              helpers
                          );
                      if (profile.kind === "named-playlist")
                          return createNamedPlaylistDriver(
                              profile,
                              ports,
                              owner
                          );
                      if (
                          profile.kind === "operator" ||
                          profile.kind === "xtream-fallback"
                      )
                          return createOperatorDriver(profile, ports, owner);
                      // OTTPLAY_FULL_ONLY_END
                      throw new Error(
                          "Unsupported provider kind: " + profile.kind
                      );
                  }
    );
});

// OTTPLAY_FULL_ONLY_BEGIN
function namedCredentialMessage(
    host: any,
    id: string,
    value: ProviderCredentials
): string {
    if (id === "1ott")
        return host._("Enter an ID and PIN to access this service.");
    if (id === "only4") return host._("Enter an IPTV token (10 characters).");
    if (id === "tvteam")
        return host._("Enter a playlist URL to access this service.");
    return host._(
        !value.username || !value.password
            ? "Username or password is missing."
            : "Enter a username and password to access this service."
    );
}

/** The old menu and HTML form are codecs over instance credentials, never driver state. */
function mountNamedProviderSettings(
    host: any,
    profile: ProviderDriverProfile,
    driver: ProviderDriver,
    owner: DriverLifetime,
    storage: DriverStorage
): void {
    var id = profile.id;
    var modes = ["MPEGTS", "HLS(v)", "HLS(a)"];
    var editorRevision = 0;
    var menuRevision = 0;
    function close() {
        menuRevision++;
        editorRevision++;
        host.popupList(
            host.popupActions.indexOf(host.toggleProviderSettingsVisibility) + 1
        );
    }
    function field(
        fieldName: string,
        caption: string,
        keyboard?: any,
        length?: number,
        error?: string,
        normalize?: (value: string) => string,
        refresh?: () => void
    ) {
        if (!owner.active()) return;
        var revision = ++editorRevision;
        host.editCaption = caption;
        host.editvar = (driver.credentials() as any)[fieldName];
        host.setEdit = function () {
            if (!owner.active() || editorRevision !== revision) return;
            var value = String(host.editvar);
            if (
                length &&
                value.length !== length &&
                !(id === "only4" && !value)
            ) {
                host.alert(error);
                if (!owner.active() || editorRevision !== revision) return;
                if (id === "only4") {
                    var release = function () {};
                    var timer = host.setTimeout(function () {
                        release();
                        if (owner.active() && editorRevision === revision)
                            host.showEditKey(keyboard);
                    }, 0);
                    release = owner.own(function () {
                        host.clearTimeout(timer);
                    });
                } else host.showEditKey(keyboard);
                return;
            }
            var next = driver.credentials();
            (next as any)[fieldName] = normalize ? normalize(value) : value;
            if (
                driver.saveCredentials(next) === false ||
                !owner.active() ||
                editorRevision !== revision
            )
                return;
            editorRevision++;
            if (refresh) refresh();
        };
        host.showEditKey(keyboard);
    }
    function editUser() {
        field(
            "username",
            id === "1ott"
                ? host._("Редактирование ID") + " " + profile.title
                : host._("Enter username") + " " + profile.title,
            id === "1ott" ? [0] : [0, 2],
            id === "shara-tv" ? 8 : undefined,
            host._("Enter a username (8 characters).")
        );
    }
    function editPassword() {
        field(
            "password",
            id === "1ott"
                ? host._("Редактирование PIN") + " " + profile.title
                : host._("Enter password") + " " + profile.title,
            id === "1ott" ? [0] : [0, 2],
            id === "shara-tv" ? 8 : undefined,
            host._("Enter a password (8 characters).")
        );
    }
    function editUrl() {
        field(
            "playlist",
            host._("Enter playlist URL") + " tv.team",
            undefined,
            undefined,
            undefined,
            function (value) {
                return host.OttPlayCore.operatorTvteamPlaylist(value);
            }
        );
    }
    function settingsMenu() {
        if (!owner.active()) return;
        var menu = ++menuRevision;
        editorRevision++;
        function currentMenu() {
            return owner.active() && menu === menuRevision;
        }
        var tokenProvider = id === "only4";
        var caption = host._("Settings") + " " + profile.title;
        function render() {
            host.listArray = tokenProvider
                ? [
                      host._("IPTV token"),
                      host._(
                          "Stream type: %1",
                          modes[driver.credentials().mode || 0]
                      ),
                      "",
                      (host.sNoNumbersKeys ? "" : '<div class="btn">8</div> ') +
                          host._("Load playlist"),
                  ]
                : [
                      host._("ID"),
                      host._("PIN"),
                      "",
                      (host.sNoNumbersKeys ? "" : '<div class="btn">8</div> ') +
                          host._("Restart player"),
                  ];
            host.listDataArray = host.listArray;
        }
        function refresh() {
            if (!currentMenu()) return;
            render();
            if (currentMenu()) host.showPage();
        }
        function changeMode(delta: number) {
            var next = driver.credentials();
            next.mode =
                ((next.mode || 0) + delta + modes.length) % modes.length;
            if (driver.saveCredentials(next) === false || !currentMenu())
                return;
            refresh();
            if (!currentMenu()) return;
            host.detailListAction();
            if (!currentMenu()) return;
            if (!host.playType)
                host.playChannel(host.catIndex, host.primaryIndex);
            else if (host.playType > 0)
                host.playArchive(host.playType + host.playTime);
        }
        host.selIndex = 0;
        render();
        host.getListItem = function (value: any) {
            return "&nbsp;&nbsp;" + value;
        };
        host.detailListAction = function () {
            var descriptions = tokenProvider
                ? [
                      host._("IPTV token") +
                          " " +
                          profile.title +
                          host._(" (after changing, load playlist)"),
                      host._("Select a stream type:<br>%1", modes.join(", ")),
                      "",
                      host._("Load playlist"),
                  ]
                : [
                      host._("Редактирование ID") +
                          host._(" (after changing, restart player)"),
                      host._("Редактирование PIN") +
                          host._(" (after changing, restart player)"),
                      "",
                      host._("Restart player"),
                  ];
            host.listDetail.innerHTML = descriptions[host.selIndex] || "";
            host.listFooter.innerHTML = host.renderButtonHint(
                host.keys.RETURN,
                host.strRETURN,
                "Close"
            );
            if (tokenProvider && host.selIndex < 2)
                host.listFooter.innerHTML += host.renderButtonHint(
                    host.keys.ENTER,
                    host.strENTER,
                    "Change value"
                );
            if (tokenProvider && host.selIndex === 1)
                host.listFooter.innerHTML += host.renderButtonHint(
                    host.keys.ENTER,
                    host.strENTER,
                    "Change value",
                    "&#9664;",
                    "&#9654;"
                );
        };
        host.listKeyHandler = function (key: number) {
            if (!currentMenu()) return false;
            if (key === host.keys.RETURN) {
                close();
                return true;
            }
            if (key === host.keys.N8) {
                if (tokenProvider) host.loadChannels();
                else host.restart();
                return true;
            }
            if (
                tokenProvider &&
                host.selIndex === 1 &&
                (key === host.keys.LEFT || key === host.keys.RIGHT)
            ) {
                changeMode(key === host.keys.LEFT ? -1 : 1);
                return true;
            }
            if (key !== host.keys.ENTER) return false;
            if (host.selIndex === 0) {
                if (tokenProvider)
                    field(
                        "username",
                        host._("Enter an IPTV token (10 characters)."),
                        [0, 1, 2],
                        10,
                        namedCredentialMessage(host, id, driver.credentials()),
                        undefined,
                        refresh
                    );
                else editUser();
            } else if (host.selIndex === 1) {
                if (tokenProvider) changeMode(1);
                else editPassword();
            } else if (host.selIndex === 3) {
                if (tokenProvider) host.loadChannels();
                else host.restart();
            }
            return true;
        };
        host.listDetail.innerHTML = "";
        host.listCaption.innerHTML = caption;
        host.listFooter.innerHTML = host.renderButtonHint(
            host.keys.RETURN,
            host.strRETURN,
            "Close"
        );
        host.$("#listPopUp").hide();
        host.showPage();
    }
    [editUser, editPassword].forEach(function (action: any, password) {
        action.menuTitle = function () {
            return (
                profile.title +
                ": " +
                host._(password ? "Password" : "Username")
            );
        };
        action.menuDetail = function () {
            return (
                host._(password ? "Enter password" : "Enter username") +
                " " +
                profile.title +
                host._(" (after changing, restart player)")
            );
        };
    });
    editUrl.menuTitle = function () {
        return "tv.team : " + host._("Playlist URL");
    };
    editUrl.menuDetail = function () {
        return host._(
            'Enter the tv.team playlist URL.<br>Playlist type: <b>OTTPlayer</b><br/><br/>The "/playlist.m3u8" suffix is added automatically if omitted.'
        );
    };
    settingsMenu.menuTitle = function () {
        return host._("Settings") + " " + profile.title;
    };
    host.duneAddSettings = function (index: number) {
        if (!owner.active()) return;
        if (isNaN(parseInt(storage.get("sShowArchive") || "", 10)))
            storage.set("sShowArchive", "1");
        if (id === "only4") {
            if (isNaN(parseInt(storage.get("sShowPikon") || "", 10)))
                storage.set("sShowPikon", "0");
            if (isNaN(parseInt(storage.get("ts_hls") || "", 10)))
                storage.set("ts_hls", "1");
        }
        if (
            (id === "1ott" || id === "only4") &&
            typeof host.delPopup === "function"
        )
            host.delPopup(host.restart);
        if (id === "shara-tv") {
            host.popupArray.splice(
                index,
                0,
                (editUser as any).menuTitle(),
                (editPassword as any).menuTitle()
            );
            host.popupDetail.splice(
                index,
                0,
                (editUser as any).menuDetail(),
                (editPassword as any).menuDetail()
            );
            host.popupActions.splice(index, 0, editUser, editPassword);
        } else {
            host.popupArray.splice(
                index,
                1,
                id === "tvteam" ? editUrl.menuTitle() : settingsMenu.menuTitle()
            );
            host.popupDetail.splice(
                index,
                1,
                id === "tvteam" ? editUrl.menuDetail() : ""
            );
            host.popupActions.splice(
                index,
                1,
                id === "tvteam" ? editUrl : settingsMenu
            );
        }
    };
    if (id === "tvteam" || id === "shara-tv") {
        host.getProviderParams = function () {
            if (!owner.active()) return false;
            if (driver.bootstrap) driver.bootstrap();
            var value = driver.credentials();
            if (id === "tvteam") {
                host.$("#tvteamwww").val(value.playlist);
                return value.playlist;
            }
            host.$("#login").val(value.username);
            host.$("#pass").val(value.password);
            var valid = host.OttPlayCore.operatorCredentialsValid(
                id,
                value.username,
                value.password
            );
            if (!valid)
                host.alert(
                    host._(
                        "Enter a username and password to access this service."
                    )
                );
            return valid;
        };
        host.setProviderParams = function () {
            if (!owner.active()) return false;
            var value = driver.credentials();
            var before = driver.credentials();
            if (id === "tvteam")
                value.playlist = decodeURIComponent(
                    host.$("#tvteamwww").val().trim()
                );
            else {
                value.username = decodeURIComponent(
                    host.$("#login").val().trim()
                );
                value.password = decodeURIComponent(
                    host.$("#pass").val().trim()
                );
            }
            if (driver.saveCredentials(value) === false || !owner.active())
                return false;
            if (
                !host.OttPlayCore.operatorCredentialsValid(
                    id,
                    id === "tvteam" ? value.playlist : value.username,
                    value.password
                )
            )
                host.alert(
                    id === "tvteam"
                        ? namedCredentialMessage(host, id, value)
                        : host._(
                              "Enter a username and password to access this service."
                          )
                );
            return id === "tvteam"
                ? before.playlist !== driver.credentials().playlist
                : before.username !== value.username ||
                      before.password !== value.password;
        };
    }
}

// OTTPLAY_FULL_ONLY_END

/** Retained UI/storage wire codec. No executable provider script enters this boundary. */
function mountProviderDriver(
    host: any,
    id: string,
    owner: DriverLifetime
): ProviderDriver {
    var profile = providerDriverProfiles.filter(function (value) {
        return value.id === id;
    })[0];
    if (!profile) throw new Error("Unsupported provider driver: " + id);
    var generic = false;
    // OTTPLAY_FULL_ONLY_BEGIN
    generic = profile.kind === "operator" || profile.kind === "xtream-fallback";
    var named = profile.kind === "named-playlist";
    var catalogProtocol = profile.kind === "catalog";
    // OTTPLAY_FULL_ONLY_END
    function storageFor(prefix: string): DriverStorage {
        return {
            get: function (key) {
                return host.stbGetItem(prefix + key);
            },
            remove: function (key) {
                if (owner.active()) host.stbDelItem(prefix + key);
            },
            set: function (key, value) {
                if (owner.active()) host.stbSetItem(prefix + key, value);
            },
        };
    }
    var store = storageFor(profile.prefix);
    var driver = providerDriverRegistry.create(
        id,
        {
            catalogProgress: function (scanned, items, total) {
                var doc = host.document;
                var panel = doc && doc.getElementById("dialogbox");
                if (!panel || !panel.querySelector || !doc.createElement)
                    return;
                if (!panel.querySelector(".ott-spinner")) return;
                var counter = panel.querySelector("[data-catalog-progress]");
                if (!counter) {
                    counter = doc.createElement("div");
                    counter.setAttribute("data-catalog-progress", "");
                    panel.appendChild(counter);
                }
                counter.textContent =
                    host._("Loading. Please wait...") +
                    " " +
                    scanned +
                    (total !== undefined && total >= scanned
                        ? " / " + total
                        : "") +
                    " · " +
                    profile.title +
                    ": " +
                    items;
                counter.setAttribute("data-catalog-scanned", String(scanned));
                counter.setAttribute("data-catalog-items", String(items));
            },
            channelCatalog: function (rows, hash, profile) {
                return host.__ottChannelCatalog.project(rows, hash, profile);
            },
            commit: function (writes, current, rollbackAllowed) {
                var read = host.stbGetItem,
                    writeValue = host.stbSetItem,
                    remove = host.stbDelItem;
                var batch = writes.map(function (write) {
                    var key = profile.prefix + write.key;
                    return {
                        after: write.after,
                        before: write.before,
                        storage: {
                            key: key,
                            read: function () {
                                return read.call(host, key);
                            },
                            remove: function () {
                                remove.call(host, key);
                            },
                            transaction:
                                host.ottpStorage &&
                                read === host.ottpStorage.get &&
                                writeValue === host.ottpStorage.set &&
                                remove === host.ottpStorage.del
                                    ? host.ottpStorage.transaction
                                    : undefined,
                            write: function (value: string) {
                                writeValue.call(host, key, value);
                            },
                        },
                    };
                });
                try {
                    host.commitSettingsWrites(batch, current, rollbackAllowed);
                } catch (error) {
                    if (
                        current() ||
                        batch.some(function (write) {
                            return write.storage.read() !== write.before;
                        })
                    )
                        throw error;
                    return false;
                }
                return true;
            },
            core: host.OttPlayCore,
            createLifetime: host.__ottProviderRuntime.createRegistry,
            decodeXml: function (text, format) {
                return host.__ottCatalogXml.decode(host, text, format);
            },
            deviceMac: function () {
                // Keep the persisted KBC fallback without modifying the device adapter.
                if (
                    host.AndroidInterface &&
                    typeof host.AndroidInterface.getMac === "function" &&
                    host.AndroidInterface.getMac() === "02:00:00:00:00:00"
                ) {
                    var saved = host.stbGetItem("mac");
                    if (saved) return saved;
                    var generated = "44:5c:e9:XX:XX:XX".replace(
                        /X/g,
                        function () {
                            return "0123456789abcdef".charAt(
                                Math.floor(Math.random() * 16)
                            );
                        }
                    );
                    if (owner.active()) host.stbSetItem("mac", generated);
                    return generated;
                }
                return host.stb && typeof host.stb.getMacAddress === "function"
                    ? String(host.stb.getMacAddress() || "")
                    : "";
            },
            guideNext: function () {
                return typeof host.sNextCount === "number"
                    ? host.sNextCount
                    : -1;
            },
            hash: function (name) {
                return host.xxHash32S(name, true);
            },
            intercept:
                typeof host.stbInterceptRequest === "function"
                    ? function (url) {
                          host.stbInterceptRequest(url);
                      }
                    : undefined,
            isDune: function () {
                return host.browserName() === "dune";
            },
            language: function () {
                var element = host.document && host.document.documentElement;
                var tag = element && element.lang;
                return typeof tag === "string" &&
                    /^[a-z]{2,3}(?:-|$)/i.test(tag)
                    ? tag.split("-")[0].toLowerCase()
                    : "en";
            },
            location: function () {
                return host.location ? host.location.href : "";
            },
            m3u: {
                crossOrigin: function () {
                    return !!(host.client_can && host.client_can.crossxhr);
                },
                hashText: function (value) {
                    return host.xxHash32Si(value);
                },
                hashUrl: function (value) {
                    return host.murmurhash3_32_gc(value, 10);
                },
                native: function () {
                    return !!(host.Capacitor || host.__TAURI__);
                },
                originHost: function () {
                    return host.location ? host.location.host : "";
                },
                readFile:
                    typeof host.readFile === "function"
                        ? function (path) {
                              return host.readFile(path);
                          }
                        : undefined,
                scopedKeys: function () {
                    return host.providerScopedStorageKeys
                        ? host.providerScopedStorageKeys.slice()
                        : [];
                },
                stripHttp: function (value) {
                    return host.stripHttpScheme(value);
                },
            },
            murmur: function (value, seed) {
                return host.murmurhash3_32_gc(value, seed);
            },
            now: function () {
                return Date.now() / 1000;
            },
            progress: function (message) {
                host.$(host.launch_id).append(host._(message));
            },
            relay: host.host || "",
            replaceLocation: function (value) {
                host.location.href = value;
            },
            request: function (options, done, fail) {
                var pending = host.$.ajax(options);
                pending.done(done).fail(fail);
                return function () {
                    if (typeof pending.abort === "function") pending.abort();
                };
            },
            scheme: function () {
                if (typeof host.scheme === "string" && host.scheme)
                    return host.scheme;
                var protocol = host.location && host.location.protocol;
                return protocol && protocol.indexOf("http") === 0
                    ? protocol + "//"
                    : "https://";
            },
            sourceIdentity: function () {
                return host.__ottSourceIdentity.media(host);
            },
            storage: store,
            storageFor: storageFor,
            translate: function (value) {
                return host._(value);
            },
            userAgent: function () {
                return host.navigator ? host.navigator.userAgent || "" : "";
            },
            validateUrl: function (value) {
                return host.checkProviderUrl(value);
            },
        },
        owner
    );
    if (!owner.active()) {
        driver.dispose();
        return driver;
    }
    host.__ottActiveProviderDriver = driver;
    host.p_pref = profile.prefix;
    host.ottplayDemoActive = id === "demo";
    function storageKey(key: string): string {
        return driver.storageKey
            ? driver.storageKey(key)
            : profile.prefix + key;
    }
    function providerValue(key: string) {
        return host.stbGetItem(storageKey(key));
    }
    host.providerGetItem = providerValue;
    var persistedRead = host.stbGetPersistedItem;
    host.providerGetPersistedItem = function (key: string) {
        // Foreign device storage needs its own durability contract.
        var storage = host.ottpStorage;
        return owner.active() &&
            storage &&
            host.stbGetItem === storage.get &&
            host.stbSetItem === storage.set &&
            typeof persistedRead === "function" &&
            host.stbGetPersistedItem === persistedRead
            ? persistedRead(storageKey(key))
            : null;
    };
    host.providerSetItem = function (key: string, value: string) {
        if (owner.active()) host.stbSetItem(storageKey(key), value);
    };
    host.providerDelItem = function (key: string) {
        if (owner.active()) host.stbDelItem(storageKey(key));
    };
    host.providerHasItem = function (key: string) {
        var value = providerValue(key);
        return value !== null && value !== undefined;
    };
    host.providerHasItemValue = function (key: string) {
        var value = providerValue(key);
        return value !== null && value !== undefined && value !== "";
    };
    host.getMediaArray = null;
    host.getChannelUrl = driver.stream;
    host.getChannelPicon = driver.logo;
    host.getArchiveUrl = driver.archive;
    host.getChannelEpg = function (channel: any, callback: any) {
        driver.guide(channel, function (guide) {
            callback(channel, guide);
        });
    };
    host.getCurrentChannelEpg = driver.guideCurrent
        ? function (channel: any, callback: any) {
              driver.guideCurrent!(channel, function (guide) {
                  callback(channel, guide);
              });
          }
        : null;
    if (id !== "demo")
        host.parental =
            id === "only4" || id === "kb-team"
                ? /XXX|Взрослые|Для взрослых|Эротика|18\+|ХХХ|Adults/i
                : /XXX|Взрослые|Для взрослых|Эротика|18\+|Adults/i;
    function label() {
        var config = driver.credentials();
        return (
            host._(profile.title + " settings") +
            (config.server && (!generic || config.username)
                ? ": " +
                  config.server.replace(/^https?:\/\//, "").split("/")[0] +
                  " (" +
                  config.username +
                  ")"
                : generic && config.playlist
                  ? ": " + config.playlist.substr(0, 40) + "..."
                  : "")
        );
    }
    function updateLabel() {
        var index = host.popupActions.indexOf(editSettings);
        var revision = editorRevision;
        var text = label();
        if (
            owner.active() &&
            revision === editorRevision &&
            host.popupActions[index] === editSettings
        )
            host.popupArray[index] = text;
    }
    var editorRevision = 0;
    function editSettings() {
        if (!owner.active()) return;
        var editor = ++editorRevision;
        var draft = driver.credentials();
        function currentEditor() {
            return owner.active() && editor === editorRevision;
        }
        if (!currentEditor()) return;
        var fieldRevision = 0;
        var fields = generic
            ? ["server", "username", "password", "playlist"]
            : ["server", "username", "password"];
        var titles = generic
            ? ["Server", "Login", "Password", "M3U"]
            : ["Server", "Username", "Password"];
        var prompts = generic
            ? ["Server URL", "Username", "Password", "M3U URL"]
            : ["Enter Xtream server URL", "Enter username", "Enter password"];
        var details = generic
            ? ["API server URL", "Username", "Password", "M3U URL (fallback)"]
            : prompts;
        var saveIndex = fields.length + 1;
        var saveLabel = generic ? "Save and load" : "Save and load channels";
        function render() {
            host.listArray = fields
                .map(function (field, index) {
                    var value = (draft as any)[field] || "";
                    if (field === "playlist") value = value.substr(0, 45);
                    return (
                        host._(titles[index]) +
                        ": " +
                        (index === 2 && value ? "********" : value)
                    );
                })
                .concat(["", host._(saveLabel)]);
            host.listDataArray = host.listArray;
        }
        host.selIndex = 0;
        render();
        host.getListItem = function (value: any) {
            return "&nbsp;&nbsp;" + value;
        };
        host.detailListAction = function () {
            host.listDetail.innerHTML = host._(
                host.selIndex < fields.length
                    ? details[host.selIndex]
                    : host.selIndex === saveIndex
                      ? generic
                          ? "Save & load channels"
                          : "Save settings and load channel list"
                      : ""
            );
        };
        host.listKeyHandler = function (key: number) {
            if (!currentEditor()) return false;
            if (key === host.keys.RETURN) {
                editorRevision++;
                host.popupList(
                    host.popupActions.indexOf(
                        host.toggleProviderSettingsVisibility
                    ) + 1
                );
                return true;
            }
            if (key !== host.keys.ENTER) return false;
            var selected = host.selIndex;
            if (selected < fields.length) {
                var field = ++fieldRevision;
                host.editCaption = host._(prompts[selected]);
                host.editvar = (draft as any)[fields[selected]];
                host.setEdit = function () {
                    if (!currentEditor() || field !== fieldRevision) return;
                    fieldRevision++;
                    (draft as any)[fields[selected]] = String(
                        host.editvar
                    ).trim();
                    render();
                    host.showPage();
                };
                host.showEditKey(host.keys.ENTER, selected === 2);
            } else if (selected === saveIndex) {
                if (driver.saveCredentials(draft) === false || !currentEditor())
                    return true;
                updateLabel();
                if (currentEditor()) host.loadChannels();
            }
            return true;
        };
        host.listDetail.innerHTML = "";
        host.listCaption.innerHTML = host._(
            generic ? profile.title : "Xtream Codes Provider"
        );
        host.listFooter.innerHTML = host.renderButtonHint(
            host.keys.RETURN,
            host.strRETURN,
            "Close"
        );
        host.$("#listPopUp").hide();
        host.showPage();
    }
    editSettings.menuTitle = label;
    editSettings.menuDetail = function () {
        return host._(profile.title + " settings");
    };
    host.duneAddSettings = function (index: number) {
        if (!owner.active() || !driver.capabilities.settings) return;
        host.popupActions.splice(index, 1, editSettings);
        host.popupArray.splice(index, 1, label());
        host.popupDetail.splice(index, 1, editSettings.menuDetail());
    };
    // OTTPLAY_FULL_ONLY_BEGIN
    if (named) mountNamedProviderSettings(host, profile, driver, owner, store);
    // OTTPLAY_FULL_ONLY_END
    var stalkerSettings =
        profile.kind === "stalker"
            ? host.__ottStalkerDriver.mountSettings(host, driver, owner)
            : null;
    host.__ottEditProvider = stalkerSettings && stalkerSettings.edit;
    if (stalkerSettings) host.duneAddSettings = stalkerSettings.mount;
    var specialized =
        profile.kind === "m3u"
            ? host.__ottM3uDriver
            : profile.kind === "plex"
              ? host.__ottPlexDriver
              : profile.kind === "vportal"
                ? host.__ottVPortalDriver
                : null;
    // OTTPLAY_FULL_ONLY_BEGIN
    if (catalogProtocol)
        host.__ottCatalogDrivers.mountSettings(host, driver, owner, store);
    if (profile.kind === "playlist") specialized = host.__ottPlaylistDrivers;
    if (profile.kind === "edem") specialized = host.__ottEdemDriver;
    // OTTPLAY_FULL_ONLY_END
    host.getChannelsArray = function (
        callback: () => void,
        settled?: () => void
    ) {
        if (!owner.active()) return;
        if (id === "xtream")
            host.$(host.launch_id).append(
                host._("Loading channels from Xtream API...")
            );
        driver.load(function (catalog, error, pending) {
            if (owner.active() && catalog && catalog.incremental) {
                var added: any[] = [];
                catalog.ids.forEach(function (key) {
                    if (
                        Object.prototype.hasOwnProperty.call(host.channels, key)
                    )
                        return;
                    host.channels[key] = catalog.channels[key];
                    host.cList.push(key);
                    added.push(key);
                });
                if (
                    added.length &&
                    host.__ottChannels &&
                    host.__ottChannels.append
                )
                    host.__ottChannels.append(added);
                return;
            }
            if (owner.active() && !pending && settled) settled();
            if (!owner.active()) return;
            if (id === "xtream" && catalog)
                host.__ottXtreamMedia.mount(host, driver, owner);
            if (error === "credentials" && !specialized) {
                if (stalkerSettings) stalkerSettings.edit();
                else editSettings();
                return;
            }
            if (catalog) {
                host.__ottMissingCatalogSelection = !!catalog.selectionMissing;
                host.__ottCatalogSelectedId = catalog.selectedId;
                // Catalog replacement is confined to this explicit legacy-view codec.
                host.cList = catalog.ids.slice();
                var channels =
                    catalog.channels === null ? null : host.channels || {};
                if (channels) {
                    Object.keys(channels).forEach(function (key) {
                        delete channels[key];
                    });
                    Object.keys(catalog.channels).forEach(function (key) {
                        var row = catalog.channels[key];
                        channels[key] = row;
                        if (
                            typeof row.legacyChannelId === "number" &&
                            host.__ottRecordPortHash
                        )
                            host.__ottRecordPortHash(
                                row.legacyChannelId,
                                Number(key)
                            );
                    });
                }
                host.channels = channels;
                host.cats = catalog.groups;
                host.catsArray = catalog.groupOrder.slice();
                if (catalog.epg) {
                    Object.keys(catalog.epg).forEach(function (key) {
                        host.__ottClassicGuide.seed(key, catalog.epg![key]);
                    });
                }
            }
            if (pending) return;
            if (specialized) {
                if (specialized.reportLoad(host, driver, error) === false)
                    return;
            }
            // OTTPLAY_FULL_ONLY_BEGIN
            else if (catalogProtocol) {
                host.__ottCatalogDrivers.reportLoad(host, driver, error);
            }
            // OTTPLAY_FULL_ONLY_END
            else if (stalkerSettings && error) {
                host.alert(
                    host._(
                        error === "stalker-connect"
                            ? "Failed to connect to Stalker portal"
                            : "Failed to load channels from Stalker portal"
                    )
                );
            }
            // OTTPLAY_FULL_ONLY_BEGIN
            else if (error === "named-credentials") {
                host.popupList(
                    host.popupActions.indexOf(
                        host.toggleProviderSettingsVisibility
                    ) + 1
                );
                host.infoBox(
                    namedCredentialMessage(host, id, driver.credentials())
                );
            } else if (named && error) {
                host.alert(
                    host._(
                        error === "named-catalog" &&
                            (id === "only4" || id === "shara-tv")
                            ? "Ошибка обработки списка каналов! Проверьте правильность данных!!"
                            : "Failed to load channel list!"
                    )
                );
            }
            // OTTPLAY_FULL_ONLY_END
            else if (error)
                host.alert(
                    host._(
                        error === "configure"
                            ? "Configure " +
                                  profile.title +
                                  " in Settings -> Provider Settings"
                            : error === "playlist"
                              ? "Failed to load!"
                              : error === "network"
                                ? "Failed to connect to Xtream API server"
                                : "Failed to load channels from Xtream API"
                    )
                );
            if (owner.active()) callback();
        });
    };
    if (specialized) specialized.mount(host, driver, owner, store);
    return driver;
}

(window as any).__ottProviderDrivers = {
    createRegistry: createDriverRegistry,
    mount: mountProviderDriver,
    registry: providerDriverRegistry,
};
