/** Independent, device-local VPortal profiles. M3U settings remain untouched. */
interface VPortalProviderDriver extends ProviderDriver {
    cancelConnection(): void;
    mediaClient(): any;
    mediaItem(id: string | number): any;
    remoteProfiles?(request: any): any;
    saveConfiguration(value: any): boolean;
}

function normalizeVPortalSections(value: any): any[] | null {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) return null;
    try {
        if (JSON.stringify(value).length > 65536) return null;
        return value.map(function (section) {
            if (
                !section ||
                typeof section.title !== "string" ||
                /[\u0000-\u001f\u007f]/.test(section.title) ||
                encodeURIComponent(section.title).replace(/%[0-9A-F]{2}/g, "x")
                    .length > 512 ||
                !section.request ||
                typeof section.request !== "object" ||
                Array.isArray(section.request) ||
                Object.keys(section.request).some(function (key) {
                    return (
                        key === "key" ||
                        key === "app" ||
                        key === "__proto__" ||
                        key === "constructor" ||
                        key === "prototype"
                    );
                })
            )
                throw new Error();
            function ordered(value: any, depth: number): any {
                if (depth > 12) throw new Error();
                if (!value || typeof value !== "object") return value;
                if (Array.isArray(value))
                    return value.map(function (part) {
                        return ordered(part, depth + 1);
                    });
                var result = Object.create(null);
                Object.keys(value)
                    .sort()
                    .forEach(function (key) {
                        result[key] = ordered(value[key], depth + 1);
                    });
                return result;
            }
            var normalized: any = {
                request: JSON.parse(
                    JSON.stringify(ordered(section.request, 0))
                ),
                title: section.title,
            };
            if (section.adult) normalized.adult = true;
            if (section.sequence) normalized.sequence = true;
            return normalized;
        });
    } catch (_) {
        return null;
    }
}

function createVPortalProviderDriver(
    ports: ProviderDriverPorts,
    owner: DriverLifetime,
    helpers: any
): VPortalProviderDriver {
    var disposed = false;
    var revision = 0;
    var client: any = null;
    var ready = false;
    var catalog: DriverCatalog = helpers.emptyCatalog();
    var api = (window as any).__ottVPortal;
    function active(): boolean {
        return !disposed && owner.active();
    }
    var operations = helpers.credentials(ports, active);
    function configuration(): any {
        var value: any;
        try {
            value = JSON.parse(ports.storage.get("profiles") || "null");
        } catch (_) {}
        var config: any = { active: 0, portals: [] };
        if (
            value &&
            value.active >= 0 &&
            value.active < 15 &&
            Math.floor(value.active) === value.active
        )
            config.active = value.active;
        for (var i = 0; i < 15; i++) {
            var row = value && Array.isArray(value.portals) && value.portals[i];
            config.portals.push({
                link: row && typeof row.link === "string" ? row.link : "",
                name: row && typeof row.name === "string" ? row.name : "",
                sections: normalizeVPortalSections(row && row.sections) || [],
            });
        }
        return config;
    }
    function retire(): void {
        revision++;
        ready = false;
        catalog = helpers.emptyCatalog();
        var previous = client;
        client = null;
        if (previous) previous.dispose();
        if (driver && (driver as any).publishLibrary)
            (driver as any).publishLibrary();
    }
    function validText(value: any, limit: number): boolean {
        try {
            return (
                typeof value === "string" &&
                !/[\u0000-\u001f\u007f]/.test(value) &&
                encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x")
                    .length <= limit
            );
        } catch (_) {
            return false;
        }
    }
    function saveConfiguration(value: any): boolean {
        return operations.run(function (current: () => boolean) {
            if (
                !value ||
                !Array.isArray(value.portals) ||
                value.portals.length !== 15 ||
                typeof value.active !== "number" ||
                value.active < 0 ||
                value.active > 14 ||
                Math.floor(value.active) !== value.active
            )
                return false;
            var next: any = { active: value.active, portals: [] };
            var before = JSON.stringify(configuration());
            for (var i = 0; i < 15; i++) {
                var row = value.portals[i];
                if (
                    !row ||
                    !validText(row.name, 256) ||
                    !validText(row.link, 8192)
                )
                    return false;
                var parsed = row.link ? api.parse(row.link) : null;
                if (row.link && (!parsed || !ports.validateUrl(parsed.url)))
                    return false;
                if (!current() || JSON.stringify(configuration()) !== before)
                    return false;
                var sections = normalizeVPortalSections(row.sections);
                if (!sections) return false;
                next.portals.push({
                    link: row.link,
                    name: row.name,
                    sections: sections,
                });
            }
            if (!operations.write({ profiles: JSON.stringify(next) }, current))
                return false;
            var previous = JSON.parse(before);
            if (
                previous.active !== next.active ||
                JSON.stringify(previous.portals[previous.active]) !==
                    JSON.stringify(next.portals[next.active])
            )
                retire();
            return current();
        }, true);
    }
    var driver: VPortalProviderDriver = {
        archive: function () {
            return "";
        },
        cancelConnection: function () {
            if (!ready && client) retire();
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
            var config = configuration();
            return {
                password: "",
                playlist: config.portals[config.active].link,
                server: "",
                username: "",
            };
        },
        dispose: function () {
            if (!disposed) {
                disposed = true;
                retire();
            }
        },
        guide: function (_, done) {
            if (active()) done([]);
        },
        id: "vportal",
        libraryReady: function () {
            return active() && ready;
        },
        load: function (done) {
            operations.run(function (current: () => boolean) {
                retire();
                if (!current()) return;
                var config = configuration();
                var row = config.portals[config.active];
                var parsed = api.parse(row.link);
                if (
                    !parsed ||
                    !ports.validateUrl(parsed.url) ||
                    !row.sections.length
                ) {
                    if (current()) done(null, "credentials");
                    return;
                }
                if (!current()) return;
                var generation = revision;
                client = api.create(row.link, {
                    isCurrent: function () {
                        return current() && generation === revision;
                    },
                    sourceId: ports.sourceIdentity!(),
                    title: row.name || "VPortal",
                });
                if (!client || !current()) return;
                var published = false;
                var count = 0;
                var wanted = "";
                var legacyIndex = 0;
                try {
                    var selection = JSON.parse(
                        ports.storage.get(
                            "channelLibrary:" + ports.sourceIdentity!()
                        ) || "null"
                    );
                    wanted =
                        selection && selection.selected
                            ? String(selection.selected.itemId || "")
                            : "";
                    legacyIndex = Math.max(
                        0,
                        Number(ports.storage.get("primaryIndex")) || 0
                    );
                } catch (_) {}
                ports.progress(ports.translate("Loading channels..."));
                client.playlist(
                    row.sections,
                    function (
                        items: any[],
                        complete: boolean,
                        error?: string,
                        scanned?: number
                    ) {
                        if (!current() || generation !== revision) return;
                        if (!published) {
                            if (ports.catalogProgress)
                                ports.catalogProgress(
                                    scanned || items.length,
                                    items.length
                                );
                            else
                                ports.progress(
                                    ports.translate("Loading channels...") +
                                        " " +
                                        items.length
                                );
                        }
                        if (items.length > count) {
                            var rows = items.map(function (item: any) {
                                return {
                                    groupId: "vportal",
                                    groupName: row.name || "VPortal",
                                    itemId: "vportal:" + item.__ottPlaylistId,
                                    logo: item.logo_30x30 || "",
                                    name: item.title,
                                    providerId: "",
                                    url: "vportal:request",
                                };
                            });
                            catalog = ports.channelCatalog!(
                                rows,
                                ports.hash,
                                "vportal"
                            );
                            catalog.ids.forEach(function (id, index) {
                                catalog.channels[id].adult =
                                    Number(items[index].adult) === 1 ? 1 : 0;
                                catalog.channels[id].__ottMediaItem =
                                    items[index];
                                catalog.channels[id].__ottMediaCollection =
                                    items[index].__ottMediaCollection ||
                                    row.name ||
                                    "VPortal";
                                catalog.channels[id].__ottMediaProvider =
                                    "vportal";
                            });
                            var selectedAvailable =
                                !wanted ||
                                catalog.ids.some(function (id) {
                                    return (
                                        catalog.channels[id].itemId ===
                                            wanted ||
                                        String(id) === wanted ||
                                        "channel:" + id === wanted
                                    );
                                });
                            if (
                                !published &&
                                !complete &&
                                (wanted
                                    ? !selectedAvailable
                                    : catalog.ids.length <= legacyIndex)
                            )
                                return;
                            ready = true;
                            if (!published) {
                                catalog.selectionMissing =
                                    complete && !!wanted && !selectedAvailable;
                                published = true;
                                done(catalog);
                            } else {
                                var added = helpers.emptyCatalog();
                                added.incremental = true;
                                added.ids = catalog.ids.slice(count);
                                added.ids.forEach(function (
                                    id: string | number
                                ) {
                                    added.channels[id] = catalog.channels[id];
                                });
                                done(added);
                            }
                            count = items.length;
                        }
                        if (complete && !published)
                            done(null, error || "empty");
                        else if (
                            complete &&
                            error &&
                            (driver as any).publishError
                        )
                            (driver as any).publishError();
                    }
                );
            });
        },
        logo: function (id) {
            return catalog.channels[id] ? catalog.channels[id].logo : "";
        },
        mediaClient: function () {
            return active() && ready ? client : null;
        },
        mediaItem: function (id) {
            return active() && catalog.channels[id]
                ? catalog.channels[id].__ottMediaItem
                : null;
        },
        saveConfiguration: saveConfiguration,
        saveCredentials: function (value) {
            var config = configuration();
            var row = config.portals[config.active];
            if (row.link !== (value.playlist || "")) row.sections = [];
            row.link = value.playlist || "";
            return saveConfiguration(config);
        },
        stream: function (id) {
            return catalog.channels[id] ? catalog.channels[id].url : "";
        },
    };
    owner.own(driver.dispose);
    return driver;
}

function mountVPortalProvider(
    host: any,
    driver: VPortalProviderDriver,
    owner: DriverLifetime
): void {
    var revision = 0;
    var attached: any = null;
    var editorClient: any = null;
    function closeEditorClient(): void {
        if (editorClient) editorClient.dispose();
        editorClient = null;
    }
    function active(): boolean {
        return owner.active();
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
        return host._("VPortal profiles");
    }
    function metadata(config: any, index: number): any {
        var row = config.portals[index];
        return {
            active: config.active === index,
            history_hours: 0,
            name: row.name,
            number: index + 1,
            playlist_configured: false,
            vportal_configured: !!host.__ottVPortal.parse(row.link),
        };
    }
    function locked(): boolean {
        return (
            !!(host.__ottKiosk && host.__ottKiosk.enabled()) ||
            !!(
                host.__ottParental &&
                (host.__ottParental.needs("providers") ||
                    host.__ottParental.needs("settings"))
            )
        );
    }
    driver.remoteProfiles = function (request: any) {
        function fail(message: string): any {
            return { data: { error: message }, status: "rejected" };
        }
        var params = request.params || {};
        if (
            !active() ||
            !params ||
            typeof params !== "object" ||
            Array.isArray(params)
        )
            return fail("Invalid profile parameters.");
        var config = driver.configuration!();
        var before = JSON.stringify(config);
        if (request.action === "profiles") {
            if (Object.keys(params).length)
                return fail("The profiles query accepts no parameters.");
            return {
                data: {
                    profiles: config.portals.map(function (
                        _: any,
                        index: number
                    ) {
                        return metadata(config, index);
                    }),
                    provider: "vportal",
                },
                status: "ok",
            };
        }
        if (locked())
            return fail(
                "Unlock provider settings and kiosk on the player first."
            );
        var selecting = request.action === "profile";
        var number = params.number;
        if (
            typeof number !== "number" ||
            Math.floor(number) !== number ||
            number < 1 ||
            number > 15 ||
            Object.keys(params).length !== (selecting ? 1 : 2) ||
            Object.keys(params).some(function (key) {
                return key !== "number" && !(key === "settings" && !selecting);
            })
        )
            return fail("Choose a profile number from 1 to 15.");
        var index = number - 1;
        var fields: string[] = [];
        if (selecting) {
            if (!host.__ottVPortal.parse(config.portals[index].link))
                return fail(
                    "Configure this profile's VPortal link before selecting it."
                );
            config.active = index;
        } else {
            var settings = params.settings;
            if (
                !settings ||
                typeof settings !== "object" ||
                Array.isArray(settings)
            )
                return fail("Provide profile settings to change.");
            fields = Object.keys(settings);
            if (
                !fields.length ||
                fields.some(function (key) {
                    return key !== "name" && key !== "vportal";
                })
            )
                return fail(
                    "VPortal profiles accept name and vportal fields only."
                );
            if (
                fields.indexOf("vportal") !== -1 &&
                settings.vportal !== config.portals[index].link
            )
                config.portals[index].sections = [];
            fields.forEach(function (key) {
                config.portals[index][key === "vportal" ? "link" : key] =
                    settings[key];
            });
        }
        if (
            !active() ||
            locked() ||
            JSON.stringify(driver.configuration!()) !== before
        )
            return fail("The profile changed during validation. Try again.");
        var reload = config.active === index || selecting;
        if (reload && typeof host.loadChannels !== "function")
            return fail("The provider reload lifecycle is unavailable.");
        if (
            !driver.saveConfiguration(config) ||
            !active() ||
            JSON.stringify(driver.configuration!()) !== JSON.stringify(config)
        )
            return fail("Could not complete the profile save.");
        revision++;
        closeEditorClient();
        if (reload) host.loadChannels();
        if (
            !active() ||
            JSON.stringify(driver.configuration!()) !== JSON.stringify(config)
        )
            return fail(
                "The provider changed while saving. Check the profile before repeating."
            );
        var data: any = {
            profile: metadata(config, index),
            provider: "vportal",
            reloaded: reload,
        };
        if (selecting) data.dispatched = true;
        else {
            data.saved = true;
            data.fields = fields;
        }
        return { data: data, status: "ok" };
    };
    function edit(): boolean {
        if (!active() || locked()) return false;
        driver.cancelConnection();
        closeEditorClient();
        var editor = ++revision;
        var selected = driver.configuration!().active;
        function current(): boolean {
            return active() && revision === editor && !locked();
        }
        function list(): void {
            closeEditorClient();
            if (!current()) return;
            var config = driver.configuration!();
            host.listArray = config.portals.map(function (
                row: any,
                index: number
            ) {
                return (
                    index +
                    1 +
                    ": " +
                    escape(row.name || "VPortal") +
                    (index === config.active ? " ✓" : "") +
                    (row.link ? "" : " — " + host._("Not configured"))
                );
            });
            host.listDataArray = host.listArray;
            host.getListItem = function (value: any) {
                return "&nbsp;&nbsp;" + value;
            };
            host.listCaption.innerHTML = label();
            host.listDetail.innerHTML = "";
            host.detailListAction = function () {};
            host.selIndex = selected;
            host.listKeyHandler = function (key: number) {
                if (!current()) return false;
                if (key === host.keys.RETURN) {
                    revision++;
                    host.popupList(
                        host.popupActions.indexOf(
                            host.toggleProviderSettingsVisibility
                        ) + 1
                    );
                    return true;
                }
                if (key !== host.keys.ENTER) return false;
                selected = host.selIndex;
                open();
                return true;
            };
            host.showPage();
        }
        function open(): void {
            var config = driver.configuration!();
            var before = JSON.stringify(config);
            var row = config.portals[selected];
            var fieldRevision = 0;
            function render(): void {
                host.listArray = [
                    host._("Profile name") + ": " + escape(row.name),
                    host._("VPortal link") +
                        ": " +
                        (row.link ? "********" : ""),
                    host._("Category selection") + ": " + row.sections.length,
                    host._("Save and load channels"),
                ];
                host.listDataArray = host.listArray;
            }
            render();
            host.listCaption.innerHTML = "VPortal — " + (selected + 1);
            host.selIndex = 0;
            function mainKeys(key: number): boolean {
                if (!current()) return false;
                if (key === host.keys.RETURN) {
                    fieldRevision++;
                    list();
                    return true;
                }
                if (key !== host.keys.ENTER) return false;
                var index = host.selIndex;
                if (index === 0 || index === 1) {
                    var field = ++fieldRevision;
                    host.editCaption = host._(
                        index ? "VPortal link" : "Profile name"
                    );
                    host.editvar = index ? row.link : row.name;
                    host.setEdit = function () {
                        if (!current() || field !== fieldRevision) return;
                        fieldRevision++;
                        var value = String(host.editvar || "").trim();
                        if (index && row.link !== value) row.sections = [];
                        row[index ? "link" : "name"] = value;
                        render();
                        host.showPage();
                    };
                    host.showEditKey(host.keys.ENTER, index === 1);
                } else if (index === 2) {
                    chooseSections();
                } else if (index === 3) {
                    if (JSON.stringify(driver.configuration!()) !== before) {
                        list();
                        return true;
                    }
                    if (!host.__ottVPortal.parse(row.link)) {
                        host.alert(
                            host._(
                                "Enter the VPortal link as shown in the cabinet"
                            )
                        );
                        return true;
                    }
                    if (!row.sections.length) {
                        chooseSections();
                        return true;
                    }
                    config.active = selected;
                    if (!driver.saveConfiguration(config) || !current()) {
                        if (current())
                            host.alert(
                                host._("Could not save provider settings.")
                            );
                        return true;
                    }
                    revision++;
                    host.loadChannels();
                }
                return true;
            }
            function chooseSections(): void {
                if (!host.__ottVPortal.parse(row.link)) {
                    host.alert(
                        host._("Enter the VPortal link as shown in the cabinet")
                    );
                    return;
                }
                closeEditorClient();
                var field = ++fieldRevision;
                function pickerCurrent(): boolean {
                    return current() && fieldRevision === field;
                }
                function leave(): void {
                    fieldRevision++;
                    closeEditorClient();
                    render();
                    host.listCaption.innerHTML = "VPortal — " + (selected + 1);
                    host.selIndex = 2;
                    host.listKeyHandler = mainKeys;
                    host.showPage();
                }
                host.listArray = [host._("Loading channels...")];
                host.listDataArray = host.listArray;
                host.listCaption.innerHTML = host._("Category selection");
                host.selIndex = 0;
                host.listKeyHandler = function (key: number) {
                    if (key === host.keys.RETURN) leave();
                    return true;
                };
                host.showPage();
                editorClient = host.__ottVPortal.create(row.link, {
                    isCurrent: pickerCurrent,
                    title: row.name || "VPortal",
                });
                editorClient.sections(function (result: any) {
                    if (!pickerCurrent()) return;
                    if (result.error) {
                        leave();
                        host.alert(host._("VPortal request failed"));
                        return;
                    }
                    var choices = normalizeVPortalSections(result.items) || [];
                    function selectedIndex(section: any): number {
                        var key = JSON.stringify(section.request);
                        for (var i = 0; i < row.sections.length; i++)
                            if (JSON.stringify(row.sections[i].request) === key)
                                return i;
                        return -1;
                    }
                    function draw(): void {
                        host.listArray = choices.map(function (section: any) {
                            return (
                                (selectedIndex(section) >= 0 ? "☑ " : "☐ ") +
                                escape(section.title)
                            );
                        });
                        host.listArray.push(host._("Ok"));
                        host.listDataArray = host.listArray;
                        host.showPage();
                    }
                    host.listKeyHandler = function (key: number) {
                        if (!pickerCurrent()) return false;
                        if (
                            key === host.keys.RETURN ||
                            (key === host.keys.ENTER &&
                                host.selIndex === choices.length)
                        ) {
                            leave();
                            return true;
                        }
                        if (key !== host.keys.ENTER) return false;
                        var section = choices[host.selIndex];
                        if (!section) return true;
                        var index = selectedIndex(section);
                        if (index < 0) row.sections.push(section);
                        else row.sections.splice(index, 1);
                        draw();
                        return true;
                    };
                    draw();
                });
            }
            host.listKeyHandler = mainKeys;
            host.showPage();
        }
        host.listFooter.innerHTML = host.renderButtonHint(
            host.keys.RETURN,
            host.strRETURN,
            "Close"
        );
        host.$("#listPopUp").hide();
        list();
        return true;
    }
    edit.menuTitle = label;
    edit.menuDetail = label;
    host.__ottEditProvider = edit;
    host.duneAddSettings = function (index: number) {
        if (!active()) return;
        host.popupActions.splice(index, 1, edit);
        host.popupArray.splice(index, 1, label());
        host.popupDetail.splice(index, 1, label());
    };
    (driver as any).publishError = function () {
        if (active()) {
            var notify = host.showShift || host.alert;
            notify.call(host, host._("VPortal request failed"));
        }
    };
    (driver as any).publishLibrary = function () {
        if (!active()) return;
        attached = driver.mediaClient();
        host.providerMediaClient = attached;
        host.getMediaArray = attached ? attached.load : null;
    };
    owner.own(function () {
        revision++;
        closeEditorClient();
        if (host.providerMediaClient === attached) {
            host.providerMediaClient = null;
            host.getMediaArray = null;
        }
    });
}

(window as any).__ottVPortalDriver = {
    create: createVPortalProviderDriver,
    mount: mountVPortalProvider,
    reportLoad: function (
        host: any,
        driver: VPortalProviderDriver,
        error?: string
    ): boolean {
        if (!driver.libraryReady!()) {
            if (error && error !== "credentials")
                host.alert(
                    host._(
                        error === "empty"
                            ? "No channels loaded"
                            : "VPortal request failed"
                    )
                );
            host.__ottEditProvider();
            return false;
        }
        (driver as any).publishLibrary();
        return true;
    },
};
