/** Per-device Plex credentials and the library provider's owned lifecycle. */
interface PlexProviderDriver extends ProviderDriver {
    cancelConnection(): void;
    libraryReady(): boolean;
    mediaClient(): any;
    saveAccountCredentials(
        value: ProviderCredentials,
        account: any
    ): boolean | void;
    saveRemoteSettings?(params: any): string | string[];
}

function createPlexProviderDriver(
    ports: ProviderDriverPorts,
    owner: DriverLifetime,
    helpers: any
): PlexProviderDriver {
    var disposed = false;
    var revision = 0;
    var ready = false;
    var preparingPlaylist = false;
    var client: any = null;
    var catalog = helpers.emptyCatalog();
    var cancelConnection: (() => void) | null = null;
    var plex = (window as any).__ottPlex;
    var auth = (window as any).__ottPlexAuth;
    var modes = ["auto", "original", "compatible"];
    function active(): boolean {
        return !disposed && owner.active();
    }
    var operations = helpers.credentials(ports, active);
    function saved(): any {
        try {
            var value = JSON.parse(ports.storage.get("cfg") || "null");
            return value && typeof value === "object" && !Array.isArray(value)
                ? value
                : {};
        } catch (_) {
            return {};
        }
    }
    function configuration(): any {
        return plex.normalize(saved());
    }
    function routing(value: any): any {
        return auth && typeof auth.routing === "function"
            ? auth.routing(value)
            : null;
    }
    function cancelConnecting(): void {
        var cancel = cancelConnection;
        cancelConnection = null;
        if (cancel) {
            revision++;
            cancel();
        }
    }
    function retire(): void {
        cancelConnecting();
        revision++;
        ready = false;
        preparingPlaylist = false;
        catalog = helpers.emptyCatalog();
        var previous = client;
        client = null;
        if (previous) previous.dispose();
        if (driver && typeof (driver as any).publishLibrary === "function")
            (driver as any).publishLibrary();
    }
    function saveCredentials(
        value: ProviderCredentials,
        account?: any
    ): boolean {
        return operations.run(function (current: () => boolean) {
            var previous = saved();
            var config = plex.normalize({
                address: value.server,
                folders:
                    (value as any).folders !== undefined
                        ? (value as any).folders
                        : value.server === previous.address
                          ? previous.folders
                          : undefined,
                playback: modes[value.mode || 0] || "auto",
                token: value.password,
            });
            if (!config || !ports.validateUrl(config.address) || !current())
                return false;
            var routes = routing(
                account ||
                    (config.address === previous.address &&
                    config.token === previous.token
                        ? previous.account
                        : null)
            );
            if (routes) config.account = routes;
            if (!operations.write({ cfg: JSON.stringify(config) }, current))
                return false;
            retire();
            return current();
        }, true);
    }
    var driver: PlexProviderDriver = {
        archive: function () {
            return "";
        },
        cancelConnection: function () {
            if ((!ready || preparingPlaylist) && (cancelConnection || client))
                retire();
        },
        capabilities: {
            archive: false,
            guide: false,
            libraryOnly: false,
            media: true,
            mediaPlaylist: true,
            settings: true,
        },
        configuration: configuration,
        credentials: function () {
            var value = saved();
            var mode = modes.indexOf(value.playback);
            return {
                folders: value.folders,
                mode: mode < 0 ? 0 : mode,
                password: typeof value.token === "string" ? value.token : "",
                plexAccount: routing(value.account),
                server: typeof value.address === "string" ? value.address : "",
                username: "",
            };
        },
        dispose: function () {
            if (disposed) return;
            disposed = true;
            retire();
        },
        guide: function (_, done) {
            if (active()) done([]);
        },
        id: "plex",
        libraryReady: function () {
            return active() && ready;
        },
        load: function (done) {
            operations.run(function (current: () => boolean) {
                retire();
                if (!current()) return;
                var config = configuration();
                if (!config || !ports.validateUrl(config.address)) {
                    done(null, "credentials");
                    return;
                }
                ports.progress("Connecting to Plex…");
                var request = revision;
                function isCurrent(): boolean {
                    return current() && revision === request;
                }
                function failed(): void {
                    if (!isCurrent()) return;
                    retire();
                    done(null, "plex-connect");
                }
                function connect(address: string): void {
                    if (!isCurrent()) return;
                    var connecting: any;
                    try {
                        // The chosen endpoint is transient; identity and journals use saved server ID.
                        connecting = plex.create(
                            {
                                address: address,
                                playback: config.playback,
                                token: config.token,
                            },
                            {
                                isCurrent: isCurrent,
                                onRetry: function () {
                                    if (isCurrent())
                                        ports.progress(
                                            "Server unavailable. Retrying automatically; check its address and network access."
                                        );
                                },
                                sourceId: ports.sourceIdentity!(),
                                title: "Plex",
                            }
                        );
                        client = connecting;
                        connecting.connect(function (error?: string) {
                            if (!isCurrent() || client !== connecting) return;
                            if (error) return failed();
                            ready = true;
                            if (!config.folders || !config.folders.length) {
                                done(helpers.emptyCatalog(), "folders");
                                return;
                            }
                            var started = false;
                            var wanted = "";
                            var migrated = "";
                            var legacyIndex = 0;
                            try {
                                var selected = JSON.parse(
                                    ports.storage.get(
                                        "channelLibrary:" +
                                            ports.sourceIdentity!()
                                    ) || "null"
                                );
                                wanted =
                                    (selected &&
                                        selected.selected &&
                                        String(
                                            selected.selected.itemId || ""
                                        ).replace(/^channel:/, "")) ||
                                    "";
                                if (!wanted) {
                                    var source = ports.sourceIdentity!();
                                    var journal = JSON.parse(
                                        ports.storage.get(
                                            "mediaJournal.v1:" + source
                                        ) || "null"
                                    );
                                    var last =
                                        journal &&
                                        Array.isArray(journal.history) &&
                                        journal.history[0];
                                    var match =
                                        last &&
                                        last.payload &&
                                        last.payload.request &&
                                        /^\/library\/metadata\/([1-9][0-9]*)$/.exec(
                                            last.payload.request.path
                                        );
                                    if (
                                        journal &&
                                        journal.version === 1 &&
                                        journal.sourceId === source &&
                                        last &&
                                        last.sourceId === source &&
                                        typeof last.position === "number" &&
                                        isFinite(last.position) &&
                                        last.position > 0 &&
                                        match
                                    )
                                        migrated = wanted = "plex-" + match[1];
                                }
                                legacyIndex = Math.max(
                                    0,
                                    Number(ports.storage.get("primaryIndex")) ||
                                        0
                                );
                            } catch (_) {}
                            function publish(
                                final: boolean,
                                error?: string
                            ): void {
                                if (!isCurrent()) return;
                                if (
                                    !started &&
                                    !final &&
                                    (!catalog.ids.length ||
                                        (wanted
                                            ? !catalog.channels[wanted]
                                            : catalog.ids.length <=
                                              legacyIndex))
                                )
                                    return;
                                var snapshot = helpers.emptyCatalog();
                                snapshot.ids = catalog.ids.slice();
                                catalog.ids.forEach(function (id: string) {
                                    snapshot.channels[id] =
                                        catalog.channels[id];
                                });
                                snapshot.incremental = started;
                                if (
                                    !started &&
                                    migrated &&
                                    catalog.channels[migrated]
                                )
                                    snapshot.selectedId = migrated;
                                if (
                                    !started &&
                                    final &&
                                    wanted &&
                                    !catalog.channels[wanted]
                                )
                                    snapshot.selectionMissing = true;
                                var incremental = started;
                                started = true;
                                preparingPlaylist = false;
                                done(snapshot, error, incremental);
                            }
                            preparingPlaylist = true;
                            connecting.scanFolders(
                                config.folders,
                                function (rows: any[], scanned: number) {
                                    if (!isCurrent()) return;
                                    rows.forEach(function (item) {
                                        var match =
                                            item.request &&
                                            /^\/library\/metadata\/([0-9]+)$/.exec(
                                                item.request.path
                                            );
                                        if (!match) return;
                                        var id = "plex-" + match[1];
                                        if (catalog.channels[id]) return;
                                        catalog.ids.push(id);
                                        catalog.channels[id] = {
                                            __ottMediaCollection:
                                                item.__ottMediaCollection ||
                                                "Plex",
                                            __ottMediaItem: item,
                                            adult:
                                                Number(item.adult) === 1
                                                    ? 1
                                                    : 0,
                                            category: {
                                                class: 2,
                                                name: "Plex",
                                            },
                                            channel_name: item.title,
                                            logo: "",
                                            rec: 0,
                                            time: 0,
                                            time_to: 0,
                                            url: "plex:request",
                                        };
                                    });
                                    if (!started) {
                                        if (ports.catalogProgress)
                                            ports.catalogProgress(
                                                scanned,
                                                catalog.ids.length
                                            );
                                        else
                                            ports.progress(
                                                "Plex: " +
                                                    scanned +
                                                    " · " +
                                                    catalog.ids.length
                                            );
                                    }
                                    publish(false);
                                },
                                function (error?: string) {
                                    if (!isCurrent()) return;
                                    if (
                                        error &&
                                        started &&
                                        typeof (window as any).infoBox ===
                                            "function"
                                    )
                                        (window as any).infoBox(
                                            ports.translate(
                                                "Unable to load playlist"
                                            )
                                        );
                                    publish(
                                        true,
                                        error && !started
                                            ? "plex-connect"
                                            : !catalog.ids.length
                                              ? "folders"
                                              : undefined
                                    );
                                },
                                isCurrent
                            );
                        });
                    } catch (_) {
                        failed();
                    }
                }
                var account = routing(saved().account);
                if (!account) {
                    connect(config.address);
                    return;
                }
                var finished = false;
                var cancel = auth.connect(
                    {
                        connections: account.connections,
                        id: account.id,
                        token: config.token,
                    },
                    {
                        onConnected: function (result: any) {
                            if (!isCurrent()) return;
                            finished = true;
                            cancelConnection = null;
                            connect(result.url);
                        },
                        onError: function () {
                            if (!isCurrent()) return;
                            finished = true;
                            cancelConnection = null;
                            failed();
                        },
                    }
                );
                if (!finished && isCurrent()) cancelConnection = cancel;
            });
        },
        logo: function () {
            return "";
        },
        mediaClient: function () {
            return active() && ready ? client : null;
        },
        saveAccountCredentials: saveCredentials,
        saveCredentials: function (value) {
            return saveCredentials(value);
        },
        stream: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].url
                : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

function mountPlexProvider(
    host: any,
    driver: PlexProviderDriver,
    owner: DriverLifetime
) {
    var revision = 0;
    var attached: any = null;
    var authActive = false;
    var picker: any = null;
    var cancelPickerConnection: (() => void) | null = null;
    function cancelPicker(): void {
        var previous = picker;
        picker = null;
        var cancel = cancelPickerConnection;
        cancelPickerConnection = null;
        if (cancel) cancel();
        if (previous) previous.dispose();
    }
    function active(): boolean {
        return owner.active();
    }
    function cancelAuth(): void {
        if (authActive && host.__ottPlexAuth) host.__ottPlexAuth.cancel();
        authActive = false;
    }
    function escape(value: any): string {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    function label(): string {
        var config = driver.configuration!();
        return (
            host._("Plex settings") +
            (config ? ": " + escape(config.address) : "")
        );
    }
    function updateLabel(): void {
        if (!active()) return;
        var index = host.popupActions.indexOf(edit);
        if (index >= 0) host.popupArray[index] = label();
    }
    // The lazy provider owns wire validation and the external-save lifecycle.
    // Return only field names or a static error; credentials never reach the ACK.
    driver.saveRemoteSettings = function (params) {
        var settings = params && params.settings;
        var fields = Object.keys(settings || {});
        if (
            !params ||
            params.provider !== "plex" ||
            Object.keys(params).some(function (key) {
                return key !== "provider" && key !== "settings";
            }) ||
            !settings ||
            typeof settings !== "object" ||
            Array.isArray(settings) ||
            !fields.length ||
            fields.some(function (key) {
                return (
                    (key !== "server" && key !== "token") ||
                    typeof settings[key] !== "string" ||
                    settings[key].length > 8192
                );
            })
        )
            return "Unsupported provider settings fields.";
        if (
            fields.indexOf("token") !== -1 &&
            (settings.token.length > 1024 ||
                /[\s\u0000-\u001f\u007f]/.test(settings.token))
        )
            return "Use a Plex access token without whitespace.";
        var config = driver.credentials();
        if (settings.server !== undefined && settings.server !== config.server)
            delete (config as any).folders;
        fields.forEach(function (key) {
            config[key === "token" ? "password" : key] = settings[key];
        });
        var plex = host.__ottPlex;
        var normalized =
            plex &&
            typeof plex.normalize === "function" &&
            plex.normalize({ address: config.server, token: config.password });
        if (!normalized)
            return "Use a valid Plex server URL and access token; first setup requires both.";
        try {
            var url = new URL(normalized.address);
            if (!host.checkProviderUrl(url.href)) throw new Error();
        } catch (_) {
            return "Use a valid HTTP(S) provider URL.";
        }
        if (!active() || typeof host.loadChannels !== "function")
            return "Plex settings are unavailable on this player.";
        if (driver.saveCredentials(config) === false)
            return "Could not save provider settings.";
        // Only a persisted external save supersedes pending editor/auth callbacks.
        revision++;
        cancelAuth();
        cancelPicker();
        updateLabel();
        host.loadChannels();
        return fields;
    };
    function edit(selectFolders = false): boolean {
        if (!active() || (host.__ottKiosk && host.__ottKiosk.locked()))
            return false;
        driver.cancelConnection();
        cancelAuth();
        cancelPicker();
        var editor = ++revision;
        var fieldRevision = 0;
        var draft: any = driver.credentials();
        var modeLabels = [
            host._("Automatic"),
            host._("Original file"),
            host._("Compatible HLS"),
        ];
        function current(): boolean {
            return (
                active() &&
                revision === editor &&
                !(host.__ottKiosk && host.__ottKiosk.locked())
            );
        }
        function render(): void {
            host.listArray = [
                host._("Sign in with Plex"),
                host._("Server") + ": " + escape(draft.server),
                host._("Plex token") +
                    ": " +
                    (draft.password ? "********" : ""),
                host._("Playback") + ": " + modeLabels[draft.mode || 0],
                host._("Folders") +
                    ": " +
                    (draft.folders ? draft.folders.length : 0),
                host._("Save and open library"),
            ];
            host.listDataArray = host.listArray;
        }
        host.selIndex = 0;
        render();
        host.getListItem = function (value: any) {
            return "&nbsp;&nbsp;" + value;
        };
        host.detailListAction = function () {
            if (!current()) return;
            var details = [
                host._(
                    "Sign in to your Plex account and choose a server. No password is entered in this player."
                ),
                host._(
                    "Enter your Plex server address, for example http://192.168.1.25:32400"
                ),
                host._(
                    "Enter your Plex access token. It is saved in this device's profile."
                ),
                host._(
                    "Automatic plays supported files directly and uses compatible HLS when needed."
                ),
                host._("Folders"),
                host._("Check the connection and open your Plex libraries."),
            ];
            host.listDetail.innerHTML = details[host.selIndex] || "";
        };
        var editorDetails = host.detailListAction;
        function showEditor(): void {
            if (!current()) return;
            render();
            host.listKeyHandler = editorKey;
            host.detailListAction = editorDetails;
            host.listCaption.innerHTML = host._("Plex settings");
            host.listDetail.innerHTML = "";
            host.selIndex = 0;
            host.showPage();
        }
        function save(account?: any): void {
            if (
                !(window as any).__ottPlex.normalize({
                    address: draft.server,
                    token: draft.password,
                })
            ) {
                host.alert(
                    host._(
                        "Enter a valid Plex server address and access token."
                    )
                );
                return;
            }
            var saved = account
                ? driver.saveAccountCredentials(draft, account)
                : driver.saveCredentials(draft);
            if (saved === false || !current()) return;
            cancelAuth();
            revision++;
            updateLabel();
            host.loadChannels();
        }
        function pickFolders(): void {
            cancelPicker();
            var token = ++fieldRevision;
            function pickerCurrent(): boolean {
                return current() && token === fieldRevision;
            }
            var selected: any[] = (draft.folders || []).map(function (
                folder: any
            ) {
                return { path: folder.path, title: folder.title };
            });
            var stack: any[] = [];
            var location: any = null;
            var entries: any[] = [];
            var busy = true;
            function close(apply: boolean): void {
                if (!pickerCurrent()) return;
                if (apply) draft.folders = selected;
                fieldRevision++;
                cancelPicker();
                showEditor();
            }
            function selectedIndex(path: string): number {
                for (var i = 0; i < selected.length; i++)
                    if (selected[i].path === path) return i;
                return -1;
            }
            function renderFolders(): void {
                if (!pickerCurrent()) return;
                host.listArray = entries.map(function (entry) {
                    return entry.action === "toggle"
                        ? (selectedIndex(entry.value.path) >= 0
                              ? "[✓] "
                              : "[ ] ") + escape(entry.value.title)
                        : entry.action === "browse"
                          ? host._("Browse folders") +
                            ": " +
                            escape(entry.value.title)
                          : entry.label;
                });
                host.listDataArray = host.listArray;
                host.listCaption.innerHTML = host._("Folders");
                host.detailListAction = function () {};
                host.showPage();
            }
            function show(locationValue: any): void {
                if (!pickerCurrent() || !picker) return;
                location = locationValue;
                busy = true;
                entries = [{ action: "back", label: host._("Back") }];
                host.listDetail.innerHTML = host._("Loading. Please wait...");
                host.selIndex = 0;
                renderFolders();
                picker.folderChoices(location, function (result: any) {
                    if (!pickerCurrent()) return;
                    busy = false;
                    entries = [];
                    (result.items || []).forEach(function (entry: any) {
                        if (entry.next)
                            entries.push({
                                action: "next",
                                label: host._("Next"),
                                value: entry,
                            });
                        else {
                            entries.push({ action: "toggle", value: entry });
                            entries.push({ action: "browse", value: entry });
                        }
                    });
                    entries.push(
                        { action: "apply", label: host._("Ok") },
                        { action: "back", label: host._("Back") }
                    );
                    host.listDetail.innerHTML = result.error
                        ? host._("Plex connection failed")
                        : host._("Folders");
                    host.selIndex = 0;
                    renderFolders();
                });
            }
            host.listKeyHandler = function (key: number) {
                if (!pickerCurrent()) return false;
                if (key === host.keys.RETURN) {
                    if (!busy && stack.length) show(stack.pop());
                    else close(false);
                    return true;
                }
                if (key !== host.keys.ENTER) return false;
                var entry = entries[host.selIndex];
                if (!entry) return true;
                if (entry.action === "back") {
                    if (!busy && stack.length) show(stack.pop());
                    else close(false);
                } else if (!busy && entry.action === "apply") close(true);
                else if (!busy && entry.action === "toggle") {
                    var index = selectedIndex(entry.value.path);
                    if (index >= 0) selected.splice(index, 1);
                    else
                        selected.push({
                            path: entry.value.path,
                            title: entry.value.title,
                        });
                    renderFolders();
                } else if (
                    !busy &&
                    (entry.action === "browse" || entry.action === "next")
                ) {
                    stack.push(location);
                    show(
                        entry.action === "browse"
                            ? entry.value.browse
                            : entry.value.target
                    );
                }
                return true;
            };
            function connected(address: string): void {
                if (!pickerCurrent()) return;
                picker = host.__ottPlex.create(
                    { address: address, token: draft.password },
                    {
                        isCurrent: pickerCurrent,
                        sourceId: host.__ottSourceIdentity.media(host),
                        title: "Plex",
                    }
                );
                if (!picker) {
                    host.alert(
                        host._(
                            "Enter a valid Plex server address and access token."
                        )
                    );
                    close(false);
                    return;
                }
                picker.connect(function (error?: string) {
                    if (!pickerCurrent()) return;
                    if (error) {
                        busy = false;
                        host.listDetail.innerHTML = host._(
                            "Plex connection failed"
                        );
                    } else show(null);
                });
            }
            entries = [{ action: "back", label: host._("Back") }];
            host.selIndex = 0;
            host.listDetail.innerHTML = host._("Connecting to Plex…");
            renderFolders();
            var stored: any = driver.credentials();
            var account =
                draft.server === stored.server &&
                draft.password === stored.password &&
                stored.plexAccount;
            if (account && host.__ottPlexAuth) {
                var finished = false;
                var cancel = host.__ottPlexAuth.connect(
                    {
                        connections: account.connections,
                        id: account.id,
                        token: draft.password,
                    },
                    {
                        onConnected: function (result: any) {
                            if (!pickerCurrent()) return;
                            finished = true;
                            cancelPickerConnection = null;
                            connected(result.url);
                        },
                        onError: function () {
                            if (!pickerCurrent()) return;
                            finished = true;
                            cancelPickerConnection = null;
                            busy = false;
                            host.listDetail.innerHTML = host._(
                                "Plex connection failed"
                            );
                        },
                    }
                );
                if (!finished && pickerCurrent())
                    cancelPickerConnection = cancel;
            } else connected(draft.server);
        }

        function signIn(): void {
            if (!host.__ottPlexAuth) return;
            cancelAuth();
            authActive = true;
            var authRevision = ++fieldRevision;
            var authUrl = "";
            var servers: any[] | null = null;
            var connecting = false;
            function authCurrent(): boolean {
                return (
                    current() && authActive && fieldRevision === authRevision
                );
            }
            function back(): void {
                cancelAuth();
                fieldRevision++;
                showEditor();
            }
            function openSignIn(): void {
                if (!authCurrent() || !authUrl) return;
                try {
                    var tauri = host.__TAURI__;
                    var invoke =
                        tauri &&
                        ((tauri.core && tauri.core.invoke) || tauri.invoke);
                    if (invoke) {
                        var pending = invoke("open_plex_sign_in", {
                            url: authUrl,
                        });
                        if (pending && typeof pending.catch === "function")
                            pending.catch(function () {});
                    } else if (typeof host.openPlexSignIn === "function")
                        host.openPlexSignIn(authUrl);
                    else if (typeof host.open === "function")
                        host.open(authUrl, "_blank", "noopener,noreferrer");
                } catch (_) {}
            }
            function failure(): void {
                if (!authCurrent()) return;
                back();
                host.alert(
                    host._(
                        "Plex sign-in failed. Check the connection and try again, or enter the server address and token."
                    )
                );
            }
            host.listCaption.innerHTML = host._("Sign in with Plex");
            host.listArray = [host._("Connecting to Plex…"), host._("Cancel")];
            host.listDataArray = host.listArray;
            host.selIndex = 0;
            host.listDetail.innerHTML = "";
            host.detailListAction = function () {};
            host.listKeyHandler = function (key: number) {
                if (!authCurrent()) return false;
                if (key === host.keys.RETURN) {
                    back();
                    return true;
                }
                if (key !== host.keys.ENTER) return false;
                if (!servers) {
                    if (authUrl && host.selIndex === 0) openSignIn();
                    else if (host.selIndex === host.listArray.length - 1)
                        back();
                    return true;
                }
                if (host.selIndex >= servers.length) {
                    back();
                    return true;
                }
                if (connecting) return true;
                var selected = servers[host.selIndex];
                connecting = true;
                host.listDetail.innerHTML = host._(
                    "Checking the Plex server connection…"
                );
                host.__ottPlexAuth.connect(selected, {
                    onConnected: function (config: any) {
                        if (!authCurrent()) return;
                        if (draft.server !== config.url)
                            draft.folders = undefined;
                        draft.server = config.url;
                        draft.password = config.token;
                        save(selected);
                    },
                    onError: failure,
                });
                return true;
            };
            host.showPage();
            host.__ottPlexAuth.start(
                {
                    onError: failure,
                    onPin: function (pin: any) {
                        if (!authCurrent()) return;
                        authUrl = pin.url;
                        host.listArray = [
                            host._("Open Plex sign-in page"),
                            host._("Code") + ": " + escape(pin.code),
                            host._("Waiting for sign-in…"),
                            host._("Cancel"),
                        ];
                        host.listDataArray = host.listArray;
                        host.listDetail.innerHTML =
                            host._(
                                "Open plex.tv/link on your phone or computer and enter this code."
                            ) +
                            '<br><a target="_blank" rel="noopener noreferrer" href="' +
                            escape(authUrl) +
                            '">' +
                            host._("Open Plex sign-in page") +
                            "</a>";
                        host.showPage();
                        openSignIn();
                    },
                    onServers: function (available: any[]) {
                        if (!authCurrent()) return;
                        servers = available.slice();
                        host.listCaption.innerHTML =
                            host._("Choose Plex server");
                        host.listArray = servers.map(function (server: any) {
                            return escape(server.name || "Plex");
                        });
                        host.listArray.push(host._("Cancel"));
                        host.listDataArray = host.listArray;
                        host.selIndex = 0;
                        host.listDetail.innerHTML = servers.length
                            ? ""
                            : host._(
                                  "No Plex servers are available for this account."
                              );
                        host.showPage();
                    },
                },
                { code: true }
            );
        }
        function editorKey(key: number) {
            if (!current()) return false;
            if (key === host.keys.RETURN) {
                cancelAuth();
                revision++;
                host.popupList(
                    host.popupActions.indexOf(
                        host.toggleProviderSettingsVisibility
                    ) + 1
                );
                return true;
            }
            if (key !== host.keys.ENTER) return false;
            var index = host.selIndex;
            if (index === 0) {
                signIn();
            } else if (index === 1 || index === 2) {
                var field = ++fieldRevision;
                host.editCaption = host._(
                    index === 2
                        ? "Enter Plex token"
                        : "Enter Plex server address"
                );
                host.editvar = index === 2 ? draft.password : draft.server;
                host.setEdit = function () {
                    if (!current() || field !== fieldRevision) return;
                    fieldRevision++;
                    var value = String(host.editvar || "").trim();
                    if (index === 2) draft.password = value;
                    else {
                        if (draft.server !== value) draft.folders = undefined;
                        draft.server = value;
                    }
                    render();
                    host.showPage();
                };
                host.showEditKey(host.keys.ENTER, index === 2);
            } else if (index === 3) {
                draft.mode = ((draft.mode || 0) + 1) % 3;
                render();
                host.showPage();
            } else if (index === 4) {
                pickFolders();
            } else if (index === 5) {
                save();
            }
            return true;
        }
        host.listKeyHandler = editorKey;
        host.listDetail.innerHTML = "";
        host.listCaption.innerHTML = host._("Plex settings");
        host.listFooter.innerHTML = host.renderButtonHint(
            host.keys.RETURN,
            host.strRETURN,
            "Close"
        );
        host.$("#listPopUp").hide();
        host.showPage();
        if (selectFolders === true) pickFolders();
        return true;
    }
    edit.menuTitle = label;
    edit.menuDetail = function () {
        return host._("Plex settings");
    };
    host.__ottEditProvider = edit;
    host.__ottEditProviderFolders = function () {
        return edit(true);
    };
    host.duneAddSettings = function (index: number) {
        if (!active()) return;
        host.popupActions.splice(index, 1, edit);
        host.popupArray.splice(index, 1, label());
        host.popupDetail.splice(index, 1, edit.menuDetail());
    };
    function publish(): void {
        if (!active()) return;
        attached = driver.mediaClient();
        host.providerMediaClient = attached;
        host.getMediaArray = attached ? attached.load : null;
    }
    (driver as any).publishLibrary = publish;
    owner.own(function () {
        cancelAuth();
        cancelPicker();
        revision++;
        if (host.providerMediaClient === attached) {
            host.providerMediaClient = null;
            host.getMediaArray = null;
        }
    });
}

function reportPlexProviderLoad(
    host: any,
    driver: PlexProviderDriver,
    error?: string
): boolean {
    if (!driver.libraryReady() || error === "plex-connect") {
        // A restored kiosk cannot interact with setup or dismiss a modal error.
        if (host.__ottKiosk && host.__ottKiosk.locked()) return false;
        if (error && error !== "credentials")
            host.alert(
                host._(
                    "Could not connect to Plex. Check the server address, token and network access."
                )
            );
        if (typeof host.__ottEditProvider === "function")
            host.__ottEditProvider();
        return false;
    }
    (driver as any).publishLibrary();
    if (error === "folders") {
        if (!(host.__ottKiosk && host.__ottKiosk.locked()))
            host.__ottEditProviderFolders();
        return false;
    }
    return true;
}

(window as any).__ottPlexDriver = {
    create: createPlexProviderDriver,
    mount: mountPlexProvider,
    reportLoad: reportPlexProviderLoad,
};
