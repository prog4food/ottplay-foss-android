/** Playlist slots, catalog ownership and companion matching without player globals. */
interface M3uSlot {
    medSourceId?: string;
    medUrl?: string;
    name?: string;
    rechours: string | number;
    www: string;
}
interface M3uConfiguration {
    active: number;
    M3Us: M3uSlot[];
}
interface M3uDriverPorts extends ProviderDriverPorts {
    deviceMac?(): string;
    m3u: {
        hashUrl(value: string): number;
        hashText(value: string): number;
        stripHttp(value: string): string;
        native(): boolean;
        crossOrigin(): boolean;
        originHost(): string;
        scopedKeys(): string[];
        readFile?(path: string): string;
    };
}
interface M3uDriverHelpers {
    emptyCatalog(): DriverCatalog;
    media?(
        ports: ProviderDriverPorts,
        owner: DriverLifetime,
        helpers: any
    ): any;
    snapshot(catalog: DriverCatalog): DriverCatalog;
    transport(
        ports: ProviderDriverPorts,
        owner: DriverLifetime,
        active: () => boolean
    ): any;
}

function normalizeM3uConfiguration(
    value: any,
    fixedSlot: number
): M3uConfiguration {
    var input = value && typeof value === "object" ? value : {};
    var active = Number(input.active);
    if (
        !isFinite(active) ||
        Math.floor(active) !== active ||
        active < 0 ||
        active >= 15
    )
        active = 0;
    var slots = Array.isArray(input.M3Us) ? input.M3Us : [];
    var result: M3uConfiguration = {
        active: fixedSlot >= 0 ? fixedSlot : active,
        M3Us: [],
    };
    for (var index = 0; index < 15; index++) {
        var row =
            slots[index] && typeof slots[index] === "object"
                ? slots[index]
                : {};
        var slot: M3uSlot = {
            rechours:
                typeof row.rechours === "string" ||
                typeof row.rechours === "number"
                    ? row.rechours
                    : 0,
            www: typeof row.www === "string" ? row.www : "",
        };
        ["name", "medUrl", "medSourceId"].forEach(function (key) {
            if (typeof row[key] === "string") (slot as any)[key] = row[key];
        });
        result.M3Us.push(slot);
    }
    return result;
}

function createM3uProviderDriver(
    ports: M3uDriverPorts,
    owner: DriverLifetime,
    helpers: M3uDriverHelpers
): any {
    var disposed = false;
    var revision = 0;
    var lifetimes = ports.createLifetime();
    var catalog = helpers.emptyCatalog();
    var catalogIdentity = "";
    var guideSources: { [key: string]: string } = Object.create(null);
    var hostedGuide: any = null;
    var listeners: Array<(event: any) => void> = [];
    var fixedSlot = -1;
    function hosted(): any {
        var bridge = (window as any).__ottHostedEpg;
        return bridge && bridge.enabled() ? bridge : null;
    }
    function closeHostedGuide(): void {
        if (hostedGuide) hostedGuide.close();
        hostedGuide = null;
    }
    if (ports.isDune() && ports.location) {
        var match = /[?&]n=(\d+)(?:&|$)/.exec(ports.location());
        var number = match ? Number(match[1]) : 0;
        if (number >= 1 && number <= 15) fixedSlot = number - 1;
    }
    function active() {
        return !disposed && owner.active();
    }
    var transport = helpers.transport(ports, owner, active);
    var media = helpers.media ? helpers.media(ports, owner, helpers) : null;
    function configuration(): M3uConfiguration {
        var value: any;
        try {
            value = JSON.parse(ports.storage.get("m3uArr") || "null");
        } catch (_) {}
        return normalizeM3uConfiguration(value, fixedSlot);
    }
    function identity(config: M3uConfiguration): string {
        var slot = config.M3Us[config.active];
        return JSON.stringify([config.active, slot.www, String(slot.rechours)]);
    }
    function current(token: string): boolean {
        return active() && identity(configuration()) === token;
    }
    function ownedRow(id: string | number): any {
        return catalogIdentity && current(catalogIdentity)
            ? catalog.channels[id]
            : null;
    }
    function publish(type: string): void {
        if (!active()) return;
        var version = revision;
        var observed = catalog;
        var source = identity(configuration());
        function isCurrent() {
            return (
                active() &&
                version === revision &&
                observed === catalog &&
                current(source)
            );
        }
        listeners.slice().forEach(function (listener) {
            if (isCurrent())
                listener({
                    catalog: helpers.snapshot(catalog),
                    configuration: configuration(),
                    isCurrent: isCurrent,
                    type: type,
                });
        });
    }
    function defaultCompanion(): string {
        // Relative relays have no authority. Parse absolute/protocol-relative
        // authorities without requiring the URL constructor on legacy hosts.
        var authority = /^(?:https?:)?\/\/([^/?#\\]*)/i.exec(
            ports.relay.trim()
        );
        var address = authority
            ? authority[1].slice(authority[1].lastIndexOf("@") + 1)
            : "";
        var host = /^(\[[^\]]+\]|[^:]+)(?::[0-9]+)?$/.exec(address);
        var hostname = host ? host[1].toLowerCase().replace(/\.$/, "") : "";
        if (ports.relay && hostname !== "ottp.eu.org") return ports.relay;
        return !ports.m3u.crossOrigin() &&
            ports.m3u.originHost() !== "ottp.eu.org"
            ? "http://" + ports.m3u.originHost()
            : "http://ottp.eu.org";
    }
    function xmltvUrls(
        value: string,
        defaults: string[],
        aliases: any
    ): string[] {
        var result: string[] = [];
        String(value || "")
            .split(",")
            .forEach(function (source) {
                source = source.trim();
                if (source.charAt(0) === "#") {
                    var index = Number(source.slice(1));
                    source =
                        index > 0
                            ? defaults[index - 1]
                            : aliases[source.slice(1)];
                }
                if (typeof source !== "string") return;
                if (source.indexOf("//") === 0) source = "https:" + source;
                if (
                    /^https?:\/\//i.test(source) &&
                    result.indexOf(source) === -1
                )
                    result.push(source);
            });
        return result;
    }
    function matchingPlan(parsed: any): any {
        var plan: any = {
            aliases: Object.create(null),
            guide: [],
            logo: [],
            raw: [],
            sources: Object.create(null),
        };
        var attribute = ports.core.legacyPlaylistAttribute;
        String(attribute(parsed.header, "foss-tvg") || "")
            .split(",")
            .forEach(function (item) {
                var pair = item.trim().split("::");
                if (pair.length !== 2) return;
                if (pair[0] === "!epg-server") plan.guideServer = pair[1];
                else if (pair[0] === "!ico-server") plan.logoServer = pair[1];
                else if (pair[0].charAt(0) === "=")
                    plan.sources[pair[0]] = pair[1];
                else plan.aliases[pair[0]] = pair[1];
            });
        function sourceIds(
            value: string,
            hashed: boolean,
            result: any[]
        ): void {
            if (!value) return;
            if (value.charAt(0) === "=" && plan.sources[value] !== undefined) {
                result.length = 0;
                result.push(value);
                return;
            }
            value.split(",").forEach(function (part) {
                var source = part.trim();
                if (source.length < 2) return;
                var output: any;
                if (!hashed) output = ports.m3u.stripHttp(source);
                else {
                    if (source.charAt(0) === "#") {
                        var index = parseInt(source.slice(1), 10);
                        source = isNaN(index)
                            ? plan.aliases[source.slice(1)]
                            : plan.raw[index - 1];
                        if (source === undefined) return;
                    }
                    output = ports.m3u.hashText(ports.m3u.stripHttp(source));
                }
                if (result.indexOf(output) === -1) result.push(output);
            });
        }
        var headerUrls = [
            attribute(parsed.header, "url-tvg"),
            attribute(parsed.header, "x-tvg-url"),
        ]
            .filter(Boolean)
            .join(",");
        var nativeDefaults = xmltvUrls(headerUrls, [], plan.aliases);
        sourceIds(attribute(parsed.header, "url-tvg"), false, plan.raw);
        sourceIds(attribute(parsed.header, "x-tvg-url"), false, plan.raw);
        var bindings = (window as any).__ottGuideBindings;
        var bindingPlan = bindings ? bindings.prepare() : null;
        parsed.entries.forEach(function (entry: any) {
            var row = parsed.channels[entry.id];
            var name = entry.generatedName
                ? ports.translate("??? No channel name")
                : entry.name;
            // Companion lookup labels retain the historical first-comma spelling.
            var wireName = entry.titleHashInput || name;
            row.channel_name = name;
            var sources: any[] = [];
            sourceIds(attribute(entry.raw, "tvg-source"), true, sources);
            sourceIds(attribute(entry.raw, "url-tvg"), true, sources);
            if (ports.m3u.native() || hosted()) {
                var custom = [
                    attribute(entry.raw, "tvg-source"),
                    attribute(entry.raw, "url-tvg"),
                ]
                    .filter(Boolean)
                    .join(",");
                row.xmltv_urls = custom
                    ? xmltvUrls(custom, nativeDefaults, plan.aliases)
                    : nativeDefaults.slice();
                row.epg_external = !!(
                    !hosted() &&
                    plan.guideServer &&
                    plan.guideServer !== defaultCompanion()
                );
            }
            if (
                bindings &&
                !(sources.length === 1 && String(sources[0]).charAt(0) === "=")
            )
                bindings.apply(row, entry.id, bindingPlan);
            var titleHash = entry.titleHashInput
                ? ports.hash(entry.titleHashInput)
                : 0;
            var keys = [
                entry.id,
                ports.m3u.hashText(row.epg_manual ? row.epg : entry.epgId),
                ports.m3u.hashText(entry.epgName),
                titleHash,
            ].join("-");
            var direct =
                sources.length === 1 &&
                entry.epgId &&
                typeof sources[0] === "string" &&
                sources[0].charAt(0) === "=";
            if (direct) {
                row.epg_src = sources[0];
                row.epg_url = ports.m3u.hashText(entry.epgId);
            } else if (
                row.epg_manual ||
                titleHash !== 0 ||
                entry.epgId ||
                entry.epgName
            ) {
                plan.guide.push(
                    keys +
                        (sources.length ? "~" + sources.join("-") : "") +
                        "~" +
                        encodeURIComponent(row.epg_manual ? "" : wireName)
                );
            }
            if (
                !entry.logo &&
                (titleHash !== 0 || entry.epgId || entry.epgName)
            ) {
                // The direct-source marker is a guide route, not a logo source hash.
                plan.logo.push(
                    keys +
                        (sources.length && !direct
                            ? "~" + sources.join("-")
                            : "") +
                        "~" +
                        encodeURIComponent(wireName)
                );
            }
        });
        return plan;
    }
    function guideUrl(id: string | number): string | null {
        var row = ownedRow(id);
        return row &&
            row.epg_src &&
            row.epg_url &&
            guideSources[row.epg_src] !== undefined
            ? guideSources[row.epg_src] + row.epg_url + ".json"
            : null;
    }
    // Match transports publish only changed routing fields; the UI adapter retains its own programme state.
    function matchRequest(
        scope: any,
        token: string,
        plan: any,
        kind: string
    ): void {
        var lines: string[] = plan[kind];
        if (
            hosted() ||
            !catalog.ids.length ||
            !lines.length ||
            !scope.active() ||
            !current(token)
        )
            return;
        var metadata: any = {};
        if (ports.m3u.native()) {
            metadata.native_channels = Object.create(null);
            catalog.ids.forEach(function (id) {
                var row = catalog.channels[id];
                metadata.native_channels[String(id)] = {
                    name: row.epg_manual ? "" : row.channel_name || "",
                    tvg_id: row.epg || "",
                    tvg_name: row.tn || "",
                    xmltv_urls: (row.xmltv_urls || []).slice(),
                };
            });
        }
        ports.progress(kind === "guide" ? "epgs..." : "logos...");
        if (!scope.active() || !current(token)) return;
        var companion =
            (kind === "guide" ? plan.guideServer : plan.logoServer) ||
            defaultCompanion();
        transport.send(
            scope,
            {
                contentType: "text/plain",
                data:
                    JSON.stringify(metadata) +
                    "\n\t\n" +
                    plan.raw.join("\n") +
                    "\n\t\n" +
                    lines.join("\n") +
                    "\n",
                dataType: "text",
                timeout: 120000,
                type: "POST",
                url:
                    companion +
                    "/m3u/match-" +
                    (kind === "guide" ? "channels" : "logos"),
            },
            function (response: any) {
                if (!current(token)) return;
                var parts =
                    typeof response === "string"
                        ? response.split("\n\t\n")
                        : [];
                if (parts.length !== (kind === "guide" ? 3 : 2)) return;
                if (kind === "guide")
                    parts[2].split("\n").forEach(function (line: string) {
                        var item = line.split("~");
                        if (item.length !== 2) return;
                        var base = item[1] + "epg/";
                        // Relative sources belong to the responding companion,
                        // which may be hosted separately from the player.
                        if (
                            /^https?:\/\//i.test(companion) &&
                            !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(base)
                        )
                            try {
                                base = new URL(
                                    base,
                                    companion.replace(/\/?$/, "/")
                                ).href;
                            } catch (_) {
                                // Keep the existing request/error path for invalid URLs.
                            }
                        if (!ports.m3u.crossOrigin())
                            base = base.replace(
                                "//epg.ottp.eu.org/",
                                "//" + ports.m3u.originHost() + "/e/"
                            );
                        guideSources[item[0]] = base;
                    });
                parts[1].split("\n").forEach(function (line: string) {
                    var item = line.split("~");
                    var row = catalog.channels[item[0]];
                    if (!row || item.length !== (kind === "guide" ? 3 : 2))
                        return;
                    if (kind === "guide") {
                        row.epg_src = item[1];
                        row.epg_url = item[2];
                    } else row.logo = item[1];
                });
                publish(kind);
            },
            function () {
                /* Matching is optional; bounded ordinary EPG retries remain in the view. */
            }
        );
    }
    var driver: any = {
        archive: function (
            id: string | number,
            start: number,
            end: number
        ): string {
            var row = ownedRow(id);
            return row
                ? ports.core.providerArchiveUrl(
                      "m3u",
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
        cancelMedia: function () {
            if (media) media.cancel();
        },
        capabilities: {
            archive: true,
            guide: true,
            media: true,
            settings: true,
        },
        clearSlot: function (slot: number): void {
            if (!active() || slot < 0 || slot >= 15) return;
            ports.m3u.scopedKeys().forEach(function (key) {
                if (active())
                    ports.storage.remove(key + (slot ? String(slot) : ""));
            });
        },
        configuration: configuration,
        credentials: function (): ProviderCredentials {
            return {
                password: "",
                playlist: configuration().M3Us[configuration().active].www,
                server: "",
                username: "",
            };
        },
        currentGuideUrl: guideUrl,
        dispose: function () {
            if (disposed) return;
            disposed = true;
            closeHostedGuide();
            revision++;
            lifetimes.dispose();
            transport.dispose();
            if (media) media.dispose();
            listeners = [];
            catalog = helpers.emptyCatalog();
            catalogIdentity = "";
        },
        fixedSlot: function () {
            return fixedSlot;
        },
        guide: function (id: string | number, callback: any): void {
            if (!active()) return;
            var url = guideUrl(id);
            var row = ownedRow(id);
            var scope = lifetimes.current();
            var token = catalogIdentity;
            if (hostedGuide && row && row.epg_src === "hosted") {
                var hostedShift = Number(row.ts) || 0;
                hostedGuide.guide(id, function (rows: any) {
                    if (!current(token)) return;
                    callback(
                        rows &&
                            rows.map(function (entry: any) {
                                var copy: any = {};
                                Object.keys(entry).forEach(function (key) {
                                    copy[key] = entry[key];
                                });
                                copy.time += hostedShift;
                                copy.time_to += hostedShift;
                                return copy;
                            })
                    );
                });
                return;
            }
            if (!url || !row || !scope) {
                callback(null);
                return;
            }
            var rec = Number(row.rec);
            var shift = Number(row.ts) || 0;
            if (rec > 0)
                url +=
                    (url.indexOf("?") >= 0 ? "&" : "?") +
                    "hours=" +
                    Math.floor(rec);
            transport.send(
                scope,
                { dataType: "json", timeout: 10000, type: "GET", url: url },
                function (response: any) {
                    if (!current(token)) return;
                    var rows =
                        response && Array.isArray(response.epg_data)
                            ? response.epg_data
                            : null;
                    callback(
                        rows &&
                            rows
                                .filter(function (entry: any) {
                                    return entry && typeof entry === "object";
                                })
                                .map(function (entry: any) {
                                    var copy: any = {};
                                    Object.keys(entry).forEach(function (key) {
                                        copy[key] = entry[key];
                                    });
                                    if (copy.time > 0 && copy.time_to > 0) {
                                        copy.time += shift;
                                        copy.time_to += shift;
                                    }
                                    return copy;
                                })
                    );
                },
                function () {
                    if (current(token)) callback(null);
                }
            );
        },
        id: "m3u",
        load: function (callback: any): void {
            if (!active()) return;
            var operation = ++revision;
            var scope = lifetimes.activate("playlist");
            closeHostedGuide();
            if (!active() || !scope.active() || operation !== revision) return;
            catalog = helpers.emptyCatalog();
            catalogIdentity = "";
            guideSources = Object.create(null);
            var config = configuration();
            var slot = config.M3Us[config.active];
            var token = identity(config);
            publish("configuration");
            var finished = false;
            function complete(error?: string): void {
                if (finished || !scope.active() || !current(token)) return;
                finished = true;
                callback(helpers.snapshot(catalog), error);
            }
            function parse(text: any): void {
                if (!scope.active() || !current(token)) return;
                // Do not mistake an empty response or login/API document for an
                // empty playlist. Keep headerless lists and M3U comments valid.
                if (
                    typeof text !== "string" ||
                    /^\s*$/.test(text) ||
                    /^\s*(?:#[^\r\n]*(?:\r?\n|\r(?!\n))\s*)*(?:<|\{|\[)/.test(
                        text
                    )
                ) {
                    complete("m3u-processing");
                    return;
                }
                var parsed: any, plan: any;
                try {
                    parsed = ports.core.parseProviderPlaylist(
                        text,
                        "m3u",
                        ports.m3u.hashUrl,
                        parseInt(String(slot.rechours), 10)
                    );
                    plan = matchingPlan(parsed);
                } catch (_) {
                    complete("m3u-processing");
                    return;
                }
                if (!scope.active() || !current(token)) return;
                catalog = parsed;
                catalogIdentity = token;
                guideSources = plan.sources;
                complete();
                var bridge = hosted();
                if (bridge) {
                    // Hosted installations own guide processing even when an old
                    // playlist advertises !epg-server or !ico-server companions.
                    if (!scope.active() || !current(token)) return;
                    var entries = catalog.ids
                        .filter(function (id) {
                            // An explicit =source JSON endpoint remains owned by its provider.
                            return !catalog.channels[id].epg_src;
                        })
                        .map(function (id) {
                            var row: any = { id: id };
                            Object.keys(catalog.channels[id]).forEach(
                                function (key) {
                                    row[key] = catalog.channels[id][key];
                                }
                            );
                            return row;
                        });
                    if (entries.length)
                        hostedGuide = bridge.open(
                            entries,
                            function (mappings: any) {
                                if (!scope.active() || !current(token)) return;
                                Object.keys(mappings).forEach(function (id) {
                                    var row = catalog.channels[id];
                                    if (!row) return;
                                    row.epg_src = "hosted";
                                    row.epg_url = id;
                                    if (!row.logo && mappings[id].logo)
                                        row.logo = mappings[id].logo;
                                });
                                publish("guide");
                            },
                            function (message: string) {
                                if (scope.active() && current(token))
                                    ports.progress(message);
                            }
                        );
                    return;
                }
                matchRequest(scope, token, plan, "guide");
                matchRequest(scope, token, plan, "logo");
            }
            if (/^portal:/i.test(slot.www.trim())) {
                complete("m3u-portal");
                return;
            }
            if (!ports.validateUrl(slot.www)) {
                complete();
                return;
            }
            if (!slot.www) {
                complete("m3u-empty");
                return;
            }
            if (ports.m3u.readFile && slot.www.charAt(0) === "/") {
                try {
                    parse(ports.m3u.readFile(slot.www));
                } catch (_) {
                    complete("m3u-network");
                }
                return;
            }
            var url = slot.www;
            if (ports.intercept) {
                ports.intercept(url);
                url +=
                    (url.indexOf("?") === -1 ? "?" : "&") +
                    "url=" +
                    encodeURIComponent(slot.www);
            }
            if (!scope.active() || !current(token)) return;
            transport.send(
                scope,
                { dataType: "text", timeout: 5000, url: url },
                parse,
                function () {
                    if (!current(token)) return;
                    if (hosted()) {
                        complete("m3u-network");
                        return;
                    }
                    ports.progress(
                        "Playlist is not loading directly...Loading via server..."
                    );
                    if (!scope.active() || !current(token)) return;
                    transport.send(
                        scope,
                        {
                            data: { url: "@" + slot.www },
                            dataType: "text",
                            method: "post",
                            // Allow the companion's 60-second upstream playlist
                            // budget plus time to deliver its response.
                            timeout: 65000,
                            url: ports.relay + "/m3u/cp.php",
                        },
                        parse,
                        function () {
                            complete("m3u-network");
                        }
                    );
                }
            );
        },
        loadMedia: function (url: string, name: string, callback: any): any {
            if (!active() || !media) return function () {};
            if (/^portal:/i.test(url.trim())) {
                callback({ records: [] });
                return function () {};
            }
            return media.load(
                {
                    mac: ports.deviceMac
                        ? ports.deviceMac().replace(/:/g, "")
                        : "",
                    name: name,
                    profile: "m3u",
                    url: url,
                },
                callback
            );
        },
        logo: function (id: string | number): string {
            var row = ownedRow(id);
            return row ? row.logo || "" : "";
        },
        saveConfiguration: function (value: any): boolean {
            if (!active()) return false;
            var next = normalizeM3uConfiguration(value, fixedSlot);
            var operation = ++revision;
            if (identity(next) !== identity(configuration())) {
                closeHostedGuide();
                lifetimes.dispose();
                if (!active() || operation !== revision) return false;
                catalog = helpers.emptyCatalog();
                catalogIdentity = "";
                guideSources = Object.create(null);
            }
            ports.storage.set("m3uArr", JSON.stringify(next));
            if (!active() || operation !== revision) return false;
            publish("configuration");
            return active() && operation === revision;
        },
        saveCredentials: function (value: ProviderCredentials) {
            var config = configuration();
            config.M3Us[config.active].www = value.playlist || "";
            driver.saveConfiguration(config);
        },
        storageKey: function (key: string) {
            var slot = configuration().active;
            return (
                "m3u" +
                key +
                (ports.m3u.scopedKeys().indexOf(key) !== -1 && slot
                    ? String(slot)
                    : "")
            );
        },
        stream: function (id: string | number): string {
            var row = ownedRow(id);
            return row ? row.url || "" : "";
        },
        subscribe: function (listener: (event: any) => void) {
            listeners.push(listener);
            return function () {
                var at = listeners.indexOf(listener);
                if (at !== -1) listeners.splice(at, 1);
            };
        },
    };
    owner.own(driver.dispose);
    return driver;
}

(window as any).__ottM3uDriver = {
    create: createM3uProviderDriver,
    mount: function (host: any, driver: any, owner: any, store: any) {
        return host.__ottM3uSettings.mount(host, driver, owner, store);
    },
    reportLoad: function (host: any, driver: any, error: any) {
        return host.__ottM3uSettings.reportLoad(host, driver, error);
    },
};
