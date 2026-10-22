import { commitSettingsWrites } from "../settings/store";

/** Portable descriptions refer to local bindings; grants and media never leave the device. */
export function installOfflineProfiles(w: any, media: any): any {
    var key = "offlineProfiles";
    var bindingsKey = "offlineProfileBindings";
    var busy = false;
    function profileFailure(message: string): Error {
        var error: any = new Error(message);
        error.offlineProfile = true;
        return error;
    }
    function object(value: any): boolean {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }
    function fields(value: any, expected: string): boolean {
        return (
            object(value) && Object.keys(value).sort().join(",") === expected
        );
    }
    function bytes(value: string): number {
        return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length;
    }
    function text(value: any, max: number, empty = false): boolean {
        return (
            typeof value === "string" &&
            (empty || !!value.trim()) &&
            !/[\u0000-\u001f\u007f]/.test(value) &&
            bytes(value) <= max
        );
    }
    function relative(value: any): boolean {
        return (
            text(value, 1024) &&
            !/^[\/]|\\|^[a-z][a-z0-9+.-]*:/i.test(value) &&
            !value.split("/").some(function (part: string) {
                return part === "." || part === ".." || !part;
            })
        );
    }
    function validateProfile(value: any): boolean {
        try {
            return (
                fields(
                    value,
                    "binding_id,name,provider,selected,sources,version"
                ) &&
                value.version === 1 &&
                value.provider === "offline" &&
                text(value.name, 256, true) &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                    value.binding_id
                ) &&
                typeof value.binding_id === "string" &&
                Array.isArray(value.sources) &&
                value.sources.length <= 32 &&
                Object.keys(value.sources).length === value.sources.length &&
                value.sources.every(function (source: any, index: number) {
                    return (
                        fields(source, "key,kind,name") &&
                        source.key === "s" + index &&
                        (source.kind === "folder" || source.kind === "file") &&
                        text(source.name, 512) &&
                        !/[\/\\]/.test(source.name) &&
                        source.name !== "." &&
                        source.name !== ".." &&
                        !/^[a-z][a-z0-9+.-]*:/i.test(source.name)
                    );
                }) &&
                (value.selected === null ||
                    (fields(value.selected, "name,source_key") &&
                        relative(value.selected.name) &&
                        value.sources.some(function (source: any) {
                            return source.key === value.selected.source_key;
                        }))) &&
                bytes(JSON.stringify(value)) <= 12288
            );
        } catch (_) {
            return false;
        }
    }
    function validateStore(value: any): boolean {
        return (
            fields(value, "active,profiles,version") &&
            value.version === 1 &&
            typeof value.active === "number" &&
            value.active % 1 === 0 &&
            value.active >= -1 &&
            value.active < 15 &&
            Array.isArray(value.profiles) &&
            value.profiles.length === 15 &&
            Object.keys(value.profiles).length === 15 &&
            value.profiles.every(function (profile: any) {
                return profile === null || validateProfile(profile);
            }) &&
            (value.active < 0 || value.profiles[value.active] !== null)
        );
    }
    function read(): any {
        var raw = w.stbGetItem(key);
        if (raw) {
            var value = JSON.parse(raw);
            if (!validateStore(value))
                throw profileFailure("Invalid saved local video profiles");
            return value;
        }
        return {
            active: -1,
            profiles: Array.apply(null, Array(15)).map(function () {
                return null;
            }),
            version: 1,
        };
    }
    function signature(profile: any): string {
        return JSON.stringify({
            selected: profile.selected,
            sources: profile.sources,
        });
    }
    function localBindings(): any {
        var value = JSON.parse(w.stbGetItem(bindingsKey) || "{}");
        if (!object(value))
            throw profileFailure("Invalid local video bindings");
        return value;
    }
    function binding(profile: any, anyLibrary = false): any {
        if (!profile) return null;
        var found = localBindings()[profile.binding_id];
        return found &&
            found.signature === signature(profile) &&
            (anyLibrary || found.library === media.libraryIdentity())
            ? found
            : null;
    }
    function metadata(store: any, number: number): any {
        var profile = store.profiles[number - 1];
        return {
            active: store.active === number - 1,
            binding_required: !!profile && !binding(profile, true),
            configured: !!profile,
            name: profile ? profile.name : "",
            number: number,
            selected_name:
                profile && profile.selected ? profile.selected.name : "",
            source_count: profile ? profile.sources.length : 0,
        };
    }
    function locked(): boolean {
        return (
            !!(w.__ottKiosk && w.__ottKiosk.enabled()) ||
            !!(w.__ottParental
                ? w.__ottParental.needs("providers") ||
                  w.__ottParental.needs("settings")
                : (w.sPSprovs || w.sPSoptions) &&
                  w.parentPIN !== "*" &&
                  !w.parentAccess)
        );
    }
    function active(): boolean {
        return !!(
            w.__ottActiveProviderDriver &&
            w.__ottActiveProviderDriver.id === "offline"
        );
    }
    function uuid(): string {
        var crypto = w.crypto;
        if (!crypto || !crypto.getRandomValues)
            throw profileFailure(
                "Secure local profile identity is unavailable"
            );
        var values = new Uint8Array(16);
        crypto.getRandomValues(values);
        values[6] = (values[6] & 15) | 64;
        values[8] = (values[8] & 63) | 128;
        var hex = Array.prototype.map
            .call(values, function (value: number) {
                return ("0" + value.toString(16)).slice(-2);
            })
            .join("");
        return (
            hex.slice(0, 8) +
            "-" +
            hex.slice(8, 12) +
            "-" +
            hex.slice(12, 16) +
            "-" +
            hex.slice(16, 20) +
            "-" +
            hex.slice(20)
        );
    }
    function writeBatch(
        values: Record<string, string>,
        previous: Record<string, string | null>,
        admitted: () => boolean,
        rollback: () => boolean
    ): void {
        var readPort = w.stbGetItem,
            writePort = w.stbSetItem,
            removePort = w.stbDelItem;
        var transaction =
            w.ottpStorage &&
            readPort === w.ottpStorage.get &&
            writePort === w.ottpStorage.set &&
            removePort === w.ottpStorage.del
                ? w.ottpStorage.transaction
                : undefined;
        commitSettingsWrites(
            Object.keys(values).map(function (key) {
                return {
                    after: values[key],
                    before: previous[key],
                    storage: {
                        key: key,
                        read: function () {
                            return readPort(key);
                        },
                        remove: function () {
                            removePort(key);
                        },
                        transaction: transaction,
                        write: function (value: string) {
                            writePort(key, value);
                        },
                    },
                };
            }),
            function () {
                return (
                    readPort === w.stbGetItem &&
                    writePort === w.stbSetItem &&
                    removePort === w.stbDelItem &&
                    admitted()
                );
            },
            function () {
                return (
                    readPort === w.stbGetItem &&
                    writePort === w.stbSetItem &&
                    removePort === w.stbDelItem &&
                    rollback()
                );
            }
        );
    }
    function keepBinding(
        bindings: any,
        id: string,
        value: any,
        store: any
    ): void {
        var pinned = store.profiles
            .filter(function (entry: any) {
                return !!entry;
            })
            .map(function (entry: any) {
                return entry.binding_id;
            });
        while (
            !Object.prototype.hasOwnProperty.call(bindings, id) &&
            Object.keys(bindings).length >= 128
        ) {
            var expired = Object.keys(bindings).filter(function (key) {
                return pinned.indexOf(key) < 0;
            })[0];
            if (!expired) throw profileFailure("Local binding history is full");
            delete bindings[expired];
        }
        bindings[id] = value;
    }
    function receipt(store: any, number: number, operation: string): any {
        var row = metadata(store, number);
        var data: any = {
            binding_required: row.binding_required,
            profile: row,
            provider: "offline",
        };
        if (operation === "load") data.dispatched = true;
        else data.saved = true;
        return { data: data, status: "ok" };
    }
    function selectedId(): string {
        var list = w.curList || [];
        return String(list[w.primaryIndex] || "").replace(/^local-/, "");
    }
    function capture(catalog: any, name: string): any {
        var selected = selectedId();
        var sources = (catalog.sources || []).slice();
        (catalog.items || []).forEach(function (item: any) {
            if (
                !sources.some(function (source: any) {
                    return source.id === item.sourceId;
                })
            )
                sources.push({
                    id: item.sourceId || item.id,
                    kind: "file",
                    name: item.name,
                });
        });
        var profile: any = {
            binding_id: uuid(),
            name: name,
            provider: "offline",
            selected: null,
            sources: sources.map(function (source: any, index: number) {
                return {
                    key: "s" + index,
                    kind: source.kind === "folder" ? "folder" : "file",
                    name: String(source.name || "")
                        .split(/[\/\\]/)
                        .pop(),
                };
            }),
            version: 1,
        };
        var refs: any = {};
        sources.forEach(function (source: any, index: number) {
            refs["s" + index] = source.id;
        });
        var item = (catalog.items || []).filter(function (item: any) {
            return item.id === selected;
        })[0];
        if (selected && !item)
            throw profileFailure(
                "The selected video is unavailable; restore source access before saving"
            );
        if (item) {
            var index = sources
                .map(function (source: any) {
                    return source.id;
                })
                .indexOf(item.sourceId || item.id);
            if (index >= 0)
                profile.selected = { name: item.name, source_key: "s" + index };
        }
        if (!validateProfile(profile))
            throw profileFailure(
                "Local profile exceeds portable limits or has invalid source names"
            );
        return {
            binding: {
                library: media.libraryIdentity(),
                selected: item ? item.id : null,
                signature: signature(profile),
                sources: refs,
            },
            profile: profile,
        };
    }
    function currentProfile(): any {
        var store = read();
        return store.active < 0 ? null : store.profiles[store.active];
    }
    function filter(catalog: any): any {
        var profile = currentProfile();
        if (!profile) return catalog;
        var local = binding(profile);
        var ids = local
            ? Object.keys(local.sources).map(function (key) {
                  return local.sources[key];
              })
            : [];
        var copy = Object.assign({}, catalog);
        copy.items = local
            ? catalog.items.filter(function (item: any) {
                  return ids.indexOf(item.sourceId || item.id) >= 0;
              })
            : [];
        copy.sources = local
            ? (catalog.sources || []).filter(function (source: any) {
                  return ids.indexOf(source.id) >= 0;
              })
            : profile.sources.map(function (source: any) {
                  return {
                      access: "binding-required",
                      available: false,
                      id: source.key,
                      kind: source.kind,
                      name: source.name,
                  };
              });
        return copy;
    }
    function selection(): string | null {
        var profile = currentProfile();
        if (!profile || !profile.selected) return null;
        var local = binding(profile);
        return local && local.selected ? "local-" + local.selected : "";
    }
    function request(request: any): Promise<any> {
        if (busy)
            return Promise.resolve({
                data: {
                    error: "Another local profile operation is in progress",
                },
                status: "rejected",
            });
        busy = true;
        var driver: any,
            before: any,
            bindingBefore: any,
            readPort: any,
            writePort: any,
            library: any,
            endpointBefore: string | null;
        function owner(): boolean {
            return (
                active() &&
                w.__ottActiveProviderDriver === driver &&
                !locked() &&
                readPort === w.stbGetItem &&
                writePort === w.stbSetItem
            );
        }
        function current(): boolean {
            return (
                owner() &&
                media.libraryIdentity() === library &&
                w.stbGetItem(key) === before &&
                w.stbGetItem(bindingsKey) === bindingBefore
            );
        }
        function run(): any {
            driver = w.__ottActiveProviderDriver;
            before = w.stbGetItem(key);
            bindingBefore = w.stbGetItem(bindingsKey);
            readPort = w.stbGetItem;
            writePort = w.stbSetItem;
            library = media.libraryIdentity();
            endpointBefore = w.stbGetItem("localMediaEndpoint");
            if (!active())
                throw profileFailure(
                    "Select Local videos before managing local profiles"
                );
            var action = request.action;
            var params = request.params === undefined ? {} : request.params;
            var store = read();
            if (action === "profiles") {
                if (!fields(params, ""))
                    throw profileFailure(
                        "The profiles query accepts no parameters"
                    );
                return {
                    data: {
                        profiles: store.profiles.map(function (
                            _: any,
                            index: number
                        ) {
                            return metadata(store, index + 1);
                        }),
                        provider: "offline",
                    },
                    status: "ok",
                };
            }
            if (locked())
                throw profileFailure(
                    "Unlock provider settings and kiosk mode first"
                );
            var number = params && params.number;
            if (
                !object(params) ||
                typeof number !== "number" ||
                number % 1 ||
                number < 1 ||
                number > 15
            )
                throw profileFailure("Choose a profile number from 1 to 15");
            var profile = store.profiles[number - 1];
            if (action === "profile_export") {
                if (!fields(params, "number") || !profile)
                    throw profileFailure(
                        "Configure this local profile before exporting it"
                    );
                return {
                    data: {
                        number: number,
                        profile: profile,
                        provider: "offline",
                    },
                    status: "ok",
                };
            }
            if (action === "profile_save") {
                if (store.active >= 0 && !binding(store.profiles[store.active]))
                    throw profileFailure(
                        "Bind the loaded profile to local sources before saving"
                    );
                if (
                    !(
                        fields(params, "number") ||
                        fields(params, "name,number")
                    ) ||
                    (params.name !== undefined && !text(params.name, 256, true))
                )
                    throw profileFailure("Invalid local profile name");
                var selectionBefore = selectedId();
                return catalogSnapshot().then(function (catalog: any) {
                    if (!current() || selectedId() !== selectionBefore)
                        throw profileFailure(
                            "Local profile changed while reading sources"
                        );
                    var captured = capture(
                        filter(catalog),
                        params.name === undefined
                            ? profile
                                ? profile.name
                                : ""
                            : params.name
                    );
                    var bindings = localBindings();
                    var existing = Object.keys(bindings).filter(function (id) {
                        return (
                            JSON.stringify(bindings[id]) ===
                            JSON.stringify(captured.binding)
                        );
                    })[0];
                    if (existing) captured.profile.binding_id = existing;
                    else
                        keepBinding(
                            bindings,
                            captured.profile.binding_id,
                            captured.binding,
                            store
                        );
                    store.profiles[number - 1] = captured.profile;
                    var values: Record<string, string> = {};
                    values[bindingsKey] = JSON.stringify(bindings);
                    values[key] = JSON.stringify(store);
                    var previous: Record<string, string | null> = {};
                    previous[bindingsKey] = bindingBefore;
                    previous[key] = before;
                    writeBatch(
                        values,
                        previous,
                        function () {
                            return (
                                owner() &&
                                media.libraryIdentity() === library &&
                                selectedId() === selectionBefore
                            );
                        },
                        owner
                    );
                    bindingBefore = values[bindingsKey];
                    before = values[key];
                    if (!current())
                        throw profileFailure(
                            "Local profile changed while saving"
                        );
                    return receipt(store, number, "save");
                });
            }
            if (action === "profile_import") {
                if (
                    !fields(params, "number,profile") ||
                    !validateProfile(params.profile)
                )
                    throw profileFailure(
                        "Invalid portable local video profile"
                    );
                if (store.active === number - 1)
                    throw profileFailure(
                        "Import into an inactive local profile, then load it"
                    );
                store.profiles[number - 1] = params.profile;
            } else if (action === "profile") {
                if (!fields(params, "number") || !profile)
                    throw profileFailure(
                        "Configure this local profile before loading it"
                    );
                if (typeof w.loadChannels !== "function")
                    throw profileFailure("Playlist reload is unavailable");
                store.active = number - 1;
            } else throw profileFailure("Unsupported local profile operation");
            if (!current())
                throw profileFailure("Local profile changed while validating");
            var reload = w.loadChannels;
            var savedLibrary =
                action === "profile" ? binding(profile, true) : null;
            var targetLibrary = savedLibrary ? savedLibrary.library : library;
            var writes: Record<string, string> = {};
            var librarySetting: any = null;
            if (targetLibrary !== library) {
                if (typeof media.libraryWrite !== "function")
                    throw profileFailure(
                        "Restore this profile's local library endpoint first"
                    );
                librarySetting = media.libraryWrite(targetLibrary);
                if (
                    !librarySetting ||
                    librarySetting.key !== "localMediaEndpoint" ||
                    typeof librarySetting.value !== "string"
                )
                    throw profileFailure("Invalid local library restoration");
                writes[librarySetting.key] = librarySetting.value;
            }
            writes[key] = JSON.stringify(store);
            var originalLibrary = library;
            var previous: Record<string, string | null> = {};
            previous[key] = before;
            if (librarySetting) previous[librarySetting.key] = endpointBefore;
            writeBatch(
                writes,
                previous,
                function () {
                    return (
                        owner() &&
                        w.stbGetItem(bindingsKey) === bindingBefore &&
                        (media.libraryIdentity() === originalLibrary ||
                            media.libraryIdentity() === targetLibrary)
                    );
                },
                owner
            );
            before = writes[key];
            library = targetLibrary;
            if (
                !current() ||
                (action === "profile" && w.loadChannels !== reload)
            )
                throw profileFailure("Local profile changed while saving");
            if (librarySetting && typeof media.didRestoreLibrary === "function")
                media.didRestoreLibrary();
            if (!current())
                throw profileFailure("Local profile changed before reload");
            if (action === "profile") reload();
            if (!current())
                throw profileFailure("Local profile changed while reloading");
            return receipt(
                store,
                number,
                action === "profile" ? "load" : "import"
            );
        }
        return Promise.resolve()
            .then(run)
            .then(
                function (result: any) {
                    busy = false;
                    return result;
                },
                function (error: any) {
                    busy = false;
                    return {
                        data: {
                            error:
                                error && error.offlineProfile
                                    ? error.message
                                    : "Local profile operation failed",
                        },
                        status: "rejected",
                    };
                }
            );
    }
    function completeCatalog(catalog: any): void {
        if (
            !catalog ||
            !Array.isArray(catalog.items) ||
            catalog.scanning ||
            catalog.cancelled
        )
            throw profileFailure(
                "Wait for the local media scan to finish before saving or binding a profile"
            );
    }
    function bind(catalog: any): void {
        completeCatalog(catalog);
        if (busy || locked() || !active())
            throw profileFailure(
                "Unlock Local videos before binding a profile"
            );
        var before = w.stbGetItem(key),
            bindingBefore = w.stbGetItem(bindingsKey);
        var store = read(),
            profile = store.profiles[store.active];
        if (!profile)
            throw profileFailure("Load a local profile before binding it");
        var sources = catalog.sources || [],
            refs: any = {};
        profile.sources.forEach(function (source: any) {
            var matches = sources.filter(function (candidate: any) {
                return (
                    candidate.name === source.name &&
                    candidate.kind === source.kind
                );
            });
            if (matches.length !== 1)
                throw profileFailure(
                    "Connect exactly one matching source for " + source.name
                );
            refs[source.key] = matches[0].id;
        });
        var selected: any = null;
        if (profile.selected) {
            var matches = catalog.items.filter(function (item: any) {
                return (
                    (item.sourceId || item.id) ===
                        refs[profile.selected.source_key] &&
                    item.name === profile.selected.name
                );
            });
            if (matches.length !== 1)
                throw profileFailure(
                    "The saved video is missing or ambiguous in the connected source"
                );
            selected = matches[0].id;
        }
        var bindings = localBindings();
        keepBinding(
            bindings,
            profile.binding_id,
            {
                library: media.libraryIdentity(),
                selected: selected,
                signature: signature(profile),
                sources: refs,
            },
            store
        );
        var driver = w.__ottActiveProviderDriver,
            library = media.libraryIdentity();
        var values: Record<string, string> = {};
        values[bindingsKey] = JSON.stringify(bindings);
        var admitted = function () {
            return (
                !locked() &&
                driver === w.__ottActiveProviderDriver &&
                before === w.stbGetItem(key) &&
                library === media.libraryIdentity()
            );
        };
        var previous: Record<string, string | null> = {};
        previous[bindingsKey] = bindingBefore;
        writeBatch(values, previous, admitted, admitted);
    }
    function catalogSnapshot(): Promise<any> {
        if (typeof media.snapshot !== "function")
            return Promise.reject(
                profileFailure("Local media snapshot is unavailable")
            );
        return media.snapshot().then(
            function (catalog: any) {
                completeCatalog(catalog);
                return catalog;
            },
            function () {
                throw profileFailure(
                    "Wait for the local media scan to finish before saving or binding a profile"
                );
            }
        );
    }
    function bindCurrent(): Promise<any> {
        if (busy)
            return Promise.reject(
                profileFailure("Another local profile operation is in progress")
            );
        var profileBefore: any,
            driver: any,
            library: any,
            readPort: any,
            writePort: any;
        try {
            profileBefore = w.stbGetItem(key);
            driver = w.__ottActiveProviderDriver;
            library = media.libraryIdentity();
            readPort = w.stbGetItem;
            writePort = w.stbSetItem;
            if (locked() || !active())
                throw profileFailure(
                    "Unlock Local videos before binding a profile"
                );
            busy = true;
            return catalogSnapshot()
                .then(function (catalog: any) {
                    if (
                        locked() ||
                        driver !== w.__ottActiveProviderDriver ||
                        library !== media.libraryIdentity() ||
                        profileBefore !== w.stbGetItem(key) ||
                        readPort !== w.stbGetItem ||
                        writePort !== w.stbSetItem
                    )
                        throw profileFailure(
                            "The local profile changed while reading sources"
                        );
                    busy = false;
                    bind(catalog);
                    return catalog;
                })
                .then(
                    function (value: any) {
                        busy = false;
                        return value;
                    },
                    function (error: any) {
                        busy = false;
                        throw error;
                    }
                );
        } catch (error) {
            busy = false;
            return Promise.reject(error);
        }
    }
    var api = {
        bind: bind,
        bindCurrent: bindCurrent,
        capabilities: function () {
            return active()
                ? {
                      max_profiles: 15,
                      max_sources: 32,
                      operations: locked()
                          ? ["list"]
                          : ["list", "load", "save", "export", "import"],
                      version: 1,
                  }
                : null;
        },
        catalogGuard: function () {
            function selectionContext(): string {
                var store = read(),
                    profile =
                        store.active < 0 ? null : store.profiles[store.active];
                return JSON.stringify([
                    store.active,
                    profile,
                    profile
                        ? localBindings()[profile.binding_id] || null
                        : null,
                ]);
            }
            var readPort = w.stbGetItem,
                writePort = w.stbSetItem,
                selection = selectionContext(),
                library = media.libraryIdentity(),
                driver = w.__ottActiveProviderDriver;
            return function () {
                return (
                    readPort === w.stbGetItem &&
                    writePort === w.stbSetItem &&
                    driver === w.__ottActiveProviderDriver &&
                    selection === selectionContext() &&
                    library === media.libraryIdentity()
                );
            };
        },
        current: currentProfile,
        filter: filter,
        namespace: function () {
            var store = read();
            return store.active < 0 ? "offline" : "offline:" + store.active;
        },
        read: read,
        request: request,
        selection: selection,
        validateProfile: validateProfile,
        validateStore: validateStore,
    };
    w.__ottOfflineProfiles = api;
    return api;
}
