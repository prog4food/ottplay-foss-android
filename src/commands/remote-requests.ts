import {
    checkProviderUrl,
    isProviderAllowed,
    providerIds,
    providerLabels,
    selectProviderByIndex,
} from "../provider";
import { caselessKey } from "../utils/caseless";
import { handleCommand } from "./index";
import { executeRemoteAppUpdate } from "./remote-app-update";
import { handleRemoteArchive } from "./remote-archive";
import { executeRemoteFavorites } from "./remote-favorites";
import { executeRemoteHandoff } from "./remote-handoff";
import { remotePlexQueue } from "./remote-plex";
import { handleRemoteProfiles } from "./remote-profiles";
import {
    executeRemoteControl,
    executeRemoteRestart,
    remotePlayerInfo,
} from "./remote-restart";
import { executeRemoteScreenshot } from "./remote-screenshot";

// Keep the source and catalogue fingerprint on the player; only an opaque
// receipt crosses the control transport. It authorizes no additional access.
var remoteEpgCatalog: any = null;

/** Read only producer-owned, allowlisted snapshots; never raw diagnostics or logs. */
function remoteSnapshot(read: any): any {
    if (typeof read !== "function") return { available: false };
    try {
        var value = read();
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            value.available === true &&
            typeof value.enabled === "boolean"
        )
            return value;
    } catch (_) {}
    return { available: true, enabled: null };
}

/** Queries expose metadata only: never URLs, credentials or the settings store. */
export function executeRemoteRequest(
    request: any,
    done: (result: any) => void,
    afterReply?: (effect: () => void) => void
): (() => void) | void {
    var w = window as any;
    var params = request.params || {};
    if (
        request.action === "playback_handoff_export" ||
        request.action === "playback_handoff_import"
    ) {
        executeRemoteHandoff(w, request, done);
        return;
    }
    if (request.action === "inspect" && w.__ottRemoteInspect)
        return w.__ottRemoteInspect.request(request, done);
    if (request.action === "favorites")
        return executeRemoteFavorites(
            w,
            remotePlayerInfo(w).runtime,
            request,
            done
        );
    if (request.action === "plex_queue" || request.action === "plex_library")
        return remotePlexQueue(w, remotePlayerInfo(w).runtime).execute(
            request,
            done
        );
    if (
        w.__ottKiosk &&
        w.__ottKiosk.enabled() &&
        [
            "app_update",
            "status",
            "screenshot",
            "channels",
            "providers",
            "profiles",
            "settings_compare",
            "programs",
            "epg_catalog",
            "restart",
            "command",
            "capabilities",
            "lifecycle",
            "input",
            "playback",
            "aspect",
        ].indexOf(request.action) < 0
    ) {
        done({
            data: {
                error: "Kiosk mode is enabled. Use kiosk set CHANNEL or kiosk off.",
            },
            status: "rejected",
        });
        return;
    }
    function reply(data: any): void {
        done({ data: data, status: "ok" });
    }
    function reject(message: string, matches?: any[]): void {
        done({
            data: { error: message, matches: matches || [] },
            status: "rejected",
        });
    }
    function volume(): number | null {
        var value =
            typeof w.stbGetVolume === "function" ? w.stbGetVolume() : null;
        return typeof value === "number" &&
            isFinite(value) &&
            value >= 0 &&
            value <= 100
            ? value
            : null;
    }
    function activeProvider(): string {
        return w.__ottActiveProviderDriver
            ? w.__ottActiveProviderDriver.id
            : String(w.stbGetItem("ottplayprov") || "");
    }
    function channels(): any[] {
        var ids = w.cList || w.curList || [];
        var seen: Record<string, boolean> = Object.create(null);
        return ids
            .filter(function (id: any) {
                if (seen[String(id)] || !(w.channels || {})[id]) return false;
                seen[String(id)] = true;
                return true;
            })
            .map(function (id: any, index: number) {
                return {
                    id: id,
                    name: String(w.channels[id].channel_name || ""),
                    number: index + 1,
                };
            });
    }
    function includes(value: string, search: string): boolean {
        return !search || caselessKey(value).indexOf(search) !== -1;
    }
    function providers(): any[] {
        return providerIds
            .map(function (id, index) {
                return {
                    active: id === activeProvider(),
                    id: id,
                    index: index,
                    name: (providerLabels && providerLabels[index]) || id,
                };
            })
            .filter(function (row) {
                return row.id && isProviderAllowed(row.id);
            });
    }
    function settingsLocked(): boolean {
        return w.__ottParental
            ? w.__ottParental.needs("providers") ||
                  w.__ottParental.needs("settings")
            : (w.sPSprovs || w.sPSoptions) &&
                  w.parentPIN !== "*" &&
                  !w.parentAccess;
    }
    if (
        request.action === "profile_save" ||
        request.action === "profile_export" ||
        request.action === "profile_import" ||
        request.action === "profiles" ||
        request.action === "profile" ||
        request.action === "profile_settings" ||
        request.action === "settings_compare"
    ) {
        handleRemoteProfiles(request, done);
        return;
    }
    if (request.action === "app_update") {
        return executeRemoteAppUpdate(w, params, done, afterReply);
    }
    if (request.action === "screenshot") {
        return executeRemoteScreenshot(w, params, done);
    }
    if (request.action === "restart") {
        executeRemoteRestart(w, params, done, afterReply);
        return;
    }
    if (
        ["capabilities", "lifecycle", "input", "playback", "aspect"].indexOf(
            request.action
        ) >= 0
    ) {
        return executeRemoteControl(
            w,
            request.action,
            params,
            done,
            afterReply,
            request.expires_at
        );
    }
    if (request.action === "status") {
        reply({
            channels: channels().length,
            player: remotePlayerInfo(w),
            ...(w.__ottKiosk ? { kiosk: w.__ottKiosk.snapshot() } : {}),
            diagnostics: {
                epg: remoteSnapshot(
                    w.__ottHostedEpg && w.__ottHostedEpg.remoteSnapshot
                ),
                input: remoteSnapshot(w.__ottDebugInputSnapshot),
                version: 1,
            },
            provider: activeProvider(),
            ready: w.commandChannelsReady === true,
            uuid: w.deviceUUID || "",
            volume: volume(),
        });
        return;
    }
    if (request.action === "providers") {
        reply({ providers: providers() });
        return;
    }
    if (
        request.action === "vportal" ||
        request.action === "vportal_search" ||
        request.action === "vportal_random"
    ) {
        var randomQueue = request.action === "vportal_random";
        var queryText =
            typeof params.query === "string" ? params.query.trim() : "";
        try {
            if (
                Object.keys(params).length !== 1 ||
                !queryText ||
                encodeURIComponent(queryText).replace(/%[0-9A-F]{2}/g, "x")
                    .length > 1024
            )
                throw new Error();
        } catch (_) {
            reject("Use a VPortal title filter of 1 to 1024 UTF-8 bytes.");
            return;
        }
        var media = w.__ottMedia;
        var client = w.providerMediaClient;
        var playback = w.__ottClassicPlayback;
        if (
            !media ||
            !playback ||
            !client ||
            typeof client.search !== "function" ||
            typeof client.resolve !== "function" ||
            typeof media.playQueue !== "function" ||
            typeof media.captureAuto !== "function" ||
            typeof media.sourceId !== "function" ||
            typeof playback.snapshot !== "function" ||
            typeof w._playMedia !== "function"
        ) {
            done({
                data: {
                    error: "Configure VPortal on a player that supports remote media queues.",
                },
                status: "unsupported",
            });
            return;
        }
        var mediaSource = media.sourceId();
        // Establish the legacy transport's current generation before guarding
        // asynchronous search; the eventual VOD handoff reconciles it too.
        if (typeof playback.reconcile === "function") playback.reconcile();
        var playbackGeneration = playback.snapshot().generation;
        var searchCurrent = media.captureAuto();
        var collecting = true;
        var complete = false;
        var cancelSearch: (() => void) | void;
        var cancelStart: (() => void) | void;
        var mediaCurrent = function (): boolean {
            return (
                !complete &&
                (!collecting || searchCurrent()) &&
                w.providerMediaClient === client &&
                media.sourceId() === mediaSource &&
                playback.snapshot().generation === playbackGeneration
            );
        };
        var cancelMediaRequest = function (): void {
            if (complete) return;
            complete = true;
            w.clearTimeout(mediaTimer);
            if (cancelSearch) cancelSearch();
            if (cancelStart) cancelStart();
        };
        var finishMedia = function (data: any, error?: string): void {
            if (complete) return;
            cancelMediaRequest();
            if (error) reject(error);
            else reply(data);
        };
        var mediaTimer = w.setTimeout(function () {
            finishMedia(null, "VPortal search or playback did not complete.");
        }, 35000);
        cancelSearch = client.search(
            queryText,
            function (result: any) {
                if (!mediaCurrent()) return;
                if (!result || result.error || !Array.isArray(result.items)) {
                    finishMedia(
                        null,
                        "Could not load the complete VPortal search results."
                    );
                    return;
                }
                var records = result.items;
                if (randomQueue) {
                    // Shuffle once; the queue repeats this complete permutation.
                    // Provider-owned results keep their original catalogue order.
                    records = records.slice();
                    for (
                        var shuffleIndex = records.length - 1;
                        shuffleIndex > 0;
                        shuffleIndex--
                    ) {
                        var selectedIndex = Math.floor(
                            Math.random() * (shuffleIndex + 1)
                        );
                        var shuffledRecord = records[shuffleIndex];
                        records[shuffleIndex] = records[selectedIndex];
                        records[selectedIndex] = shuffledRecord;
                    }
                }
                var data: any = {
                    items: records.map(function (item: any, index: number) {
                        return {
                            number: index + 1,
                            title: String(item.title || ""),
                        };
                    }),
                    total: records.length,
                };
                // Bound metadata before dispatch so a huge provider title cannot
                // turn a successful playback change into an unreadable receipt.
                if (JSON.stringify(data).length > 500000) {
                    finishMedia(
                        null,
                        "VPortal results are too large. Use a more specific title filter."
                    );
                    return;
                }
                if (request.action === "vportal_search") {
                    finishMedia(data);
                    return;
                }
                if (!records.length) {
                    finishMedia(null, "No matching VPortal titles found.");
                    return;
                }
                if (
                    w.sPSchannels &&
                    w.parentPIN !== "*" &&
                    !w.parentAccess &&
                    records.some(function (item: any) {
                        return Number(item.adult) === 1;
                    })
                ) {
                    finishMedia(
                        null,
                        "Unlock parental access on the player before starting this queue."
                    );
                    return;
                }
                // The queue takes over automatic cancellation from the search.
                collecting = false;
                cancelStart = media.playQueue(
                    records,
                    queryText,
                    mediaCurrent,
                    function () {
                        data.dispatched = true;
                        data.loop = true;
                        if (randomQueue) data.shuffled = true;
                        finishMedia(data);
                    }
                );
            },
            mediaCurrent
        );
        if (complete && cancelSearch) cancelSearch();
        return cancelMediaRequest;
    }
    if (request.action === "provider") {
        var query = String(params.query).toLowerCase();
        var providerSearch = caselessKey(query);
        var all = providers();
        var found = all.filter(function (row) {
            return (
                row.id.toLowerCase() === query || String(row.index) === query
            );
        });
        if (!found.length)
            found = all.filter(function (row) {
                return includes(row.name, providerSearch);
            });
        if (found.length !== 1) {
            reject("Choose one provider by ID or index.", found);
            return;
        }
        if (!selectProviderByIndex(found[0].index)) {
            reject(
                "Provider switch rejected; check parental access and platform policy."
            );
            return;
        }
        reply({ dispatched: true, provider: found[0].id });
        return;
    }
    if (request.action === "provider_settings") {
        var driver = w.__ottActiveProviderDriver;
        if (!driver || driver.id !== params.provider) {
            reject("Select this provider before changing its settings.");
            return;
        }
        if (!isProviderAllowed(driver.id) || settingsLocked()) {
            reject("Unlock provider settings on the player first.");
            return;
        }
        if (
            driver.id === "stalker" &&
            params.settings &&
            Object.prototype.hasOwnProperty.call(params.settings, "profile")
        ) {
            var settings = params.settings;
            try {
                if (
                    Array.isArray(settings) ||
                    Object.keys(settings).sort().join(",") !==
                        "mac,name,profile,server" ||
                    typeof settings.profile !== "number" ||
                    Math.floor(settings.profile) !== settings.profile ||
                    settings.profile < 1 ||
                    settings.profile > 15 ||
                    typeof settings.name !== "string" ||
                    /[\u0000-\u001f\u007f]/.test(settings.name) ||
                    encodeURIComponent(settings.name).replace(
                        /%[0-9A-F]{2}/g,
                        "x"
                    ).length > 256 ||
                    typeof settings.server !== "string" ||
                    settings.server.length > 8192 ||
                    /[\\\s]/.test(settings.server) ||
                    !/^https?:\/\//i.test(settings.server) ||
                    typeof settings.mac !== "string" ||
                    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(settings.mac) ||
                    typeof driver.configuration !== "function" ||
                    typeof driver.saveConfiguration !== "function"
                )
                    throw new Error();
                var stalkerEndpoint = new URL(settings.server);
                if (
                    !stalkerEndpoint.hostname ||
                    stalkerEndpoint.username ||
                    stalkerEndpoint.password ||
                    !checkProviderUrl(stalkerEndpoint.href)
                )
                    throw new Error();
                var original = JSON.stringify(driver.configuration());
                var configuration = JSON.parse(original);
                var slot = settings.profile - 1;
                if (
                    !Array.isArray(configuration.portals) ||
                    configuration.portals.length !== 15 ||
                    !configuration.portals[slot] ||
                    (configuration.active === slot &&
                        typeof w.loadChannels !== "function")
                )
                    throw new Error();
                configuration.portals[slot] = {
                    mac: settings.mac,
                    name: settings.name,
                    portal: settings.server,
                };
                var stalkerChanged = original !== JSON.stringify(configuration);
                if (
                    w.__ottActiveProviderDriver !== driver ||
                    settingsLocked() ||
                    JSON.stringify(driver.configuration()) !== original ||
                    (stalkerChanged &&
                        driver.saveConfiguration(configuration) !== true) ||
                    w.__ottActiveProviderDriver !== driver ||
                    JSON.stringify(driver.configuration()) !==
                        JSON.stringify(configuration)
                )
                    throw new Error();
                if (stalkerChanged && configuration.active === slot)
                    w.loadChannels();
                if (
                    w.__ottActiveProviderDriver !== driver ||
                    JSON.stringify(driver.configuration()) !==
                        JSON.stringify(configuration)
                )
                    throw new Error();
                reply({
                    fields: ["profile", "name", "server", "mac"],
                    profile: settings.profile,
                    provider: "stalker",
                    saved: true,
                });
            } catch (_) {
                reject("Could not validate or save the Stalker profile.");
            }
            return;
        }
        if (driver.id === "plex") {
            var plexSettings =
                typeof driver.saveRemoteSettings === "function"
                    ? driver.saveRemoteSettings(params)
                    : "Plex settings are unavailable on this player.";
            if (typeof plexSettings === "string") reject(plexSettings);
            else reply({ fields: plexSettings, provider: "plex", saved: true });
            return;
        }
        var schemas: Record<string, string[]> = {
            m3u: ["playlist"],
            ottclub: ["server", "key"],
            stalker: ["server", "mac"],
            xtream: ["server", "username", "password"],
        };
        var schema = schemas[driver.id];
        var fields = Object.keys(params.settings || {});
        if (
            !schema ||
            !params.settings ||
            typeof params.settings !== "object" ||
            Array.isArray(params.settings) ||
            !fields.length ||
            fields.some(function (key) {
                return (
                    schema.indexOf(key) < 0 ||
                    typeof params.settings[key] !== "string" ||
                    params.settings[key].length > 8192
                );
            })
        ) {
            reject("Unsupported provider settings fields.");
            return;
        }
        var config = driver.credentials();
        fields.forEach(function (key) {
            config[key === "mac" || key === "key" ? "username" : key] =
                params.settings[key];
        });
        var endpoint = driver.id === "m3u" ? config.playlist : config.server;
        if (endpoint) {
            try {
                var club = driver.id === "ottclub";
                if (club && /[\s/\\?#@]/.test(endpoint)) throw new Error();
                var parsed = new URL(club ? "http://" + endpoint : endpoint);
                if (
                    !/^https?:$/.test(parsed.protocol) ||
                    !parsed.hostname ||
                    parsed.username ||
                    parsed.password ||
                    !checkProviderUrl(parsed.href)
                )
                    throw new Error();
                // The OTTClub driver prepends HTTP to its stored host.
                if (club) config.server = parsed.host;
            } catch (_error) {
                reject(
                    driver.id === "ottclub"
                        ? "Use an OTTClub host, optionally with a port, without a URL scheme or path."
                        : "Use a valid HTTP(S) provider URL."
                );
                return;
            }
        }
        if (
            driver.id === "stalker" &&
            !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(config.username)
        ) {
            reject("Use a MAC address such as 00:1A:79:00:00:01.");
            return;
        }
        if (driver.saveCredentials(config) === false) {
            reject("Could not save provider settings.");
            return;
        }
        if (typeof w.loadPlaylist === "function") w.loadPlaylist();
        reply({ fields: fields, provider: driver.id, saved: true });
        return;
    }
    if (request.action === "command") {
        if (params.command === "exit_player") {
            if (Object.keys(params).length !== 1) {
                reject("Exit accepts no additional parameters.");
                return;
            }
            executeRemoteControl(
                w,
                "lifecycle",
                { operation: "exit_app" },
                done,
                afterReply
            );
            return;
        }
        var outcome = handleCommand(params);
        if (outcome !== "accepted") {
            reject(
                "Command " + outcome + ". Check the player state and settings."
            );
            return;
        }
        reply({
            dispatched: true,
            volume: params.command === "set_volume" ? volume() : undefined,
        });
        return;
    }
    if (w.commandChannelsReady !== true) {
        reject("Channels are still loading. Try again shortly.");
        return;
    }
    var rows = channels();
    if (
        request.action === "epg_catalog" ||
        request.action === "play_catalog" ||
        request.action === "resolve_archive" ||
        request.action === "play_archive_catalog"
    ) {
        var identity = w.__ottSourceIdentity;
        if (!identity || typeof identity.current !== "function") {
            done({
                data: { error: "Update the player for server EPG queries." },
                status: "unsupported",
            });
            return;
        }
        var catalogSource = identity.current(w);
        var catalogLoad = w.__ottCommandChannelLoad;
        // Provider-internal IDs can collide with unrelated public XMLTV IDs.
        var xmltvMetadata = activeProvider() === "m3u";
        var metadata: any[];
        var catalogSignature: string;
        try {
            if (rows.length > 10000) throw new Error();
            metadata = rows.map(function (row: any) {
                var channel = w.channels[row.id];
                var shift = Number(channel.ts) || 0;
                var entry = {
                    archiveHours: Math.min(
                        144,
                        Math.max(0, Math.floor(Number(channel.rec) || 0))
                    ),
                    id: String(row.id),
                    name: row.name,
                    number: row.number,
                    shift: shift,
                    tvgId: xmltvMetadata ? String(channel.epg || "") : "",
                    tvgName: xmltvMetadata ? String(channel.tn || "") : "",
                };
                if (
                    !entry.id ||
                    !isFinite(shift) ||
                    Math.floor(shift) !== shift ||
                    Math.abs(shift) > 86400 ||
                    [entry.id, entry.name, entry.tvgId, entry.tvgName].some(
                        function (value) {
                            return value.length > 512;
                        }
                    )
                )
                    throw new Error();
                return entry;
            });
            catalogSignature = JSON.stringify(metadata);
            // Leave room for the response envelope under the controller's 2 MiB limit.
            if (
                encodeURIComponent(catalogSignature).replace(
                    /%[A-F\d]{2}/g,
                    "x"
                ).length > 1800000
            )
                throw new Error();
        } catch (_) {
            reject("Channel metadata exceeds the server EPG limits.");
            return;
        }
        var catalogCurrent = function (): boolean {
            return (
                w.commandChannelsReady === true &&
                catalogLoad === w.__ottCommandChannelLoad &&
                catalogSource === identity.current(w)
            );
        };
        var receiptCurrent = function (): boolean {
            return (
                catalogCurrent() &&
                remoteEpgCatalog &&
                remoteEpgCatalog.source === catalogSource &&
                remoteEpgCatalog.load === catalogLoad &&
                remoteEpgCatalog.signature === catalogSignature &&
                remoteEpgCatalog.expires > Date.now()
            );
        };
        if (request.action === "epg_catalog") {
            if (Object.keys(params).length || !catalogCurrent()) {
                reject("Channels or provider changed. Retry the EPG query.");
                return;
            }
            if (!receiptCurrent()) {
                var revision =
                    remoteEpgCatalog &&
                    remoteEpgCatalog.source === catalogSource &&
                    remoteEpgCatalog.load === catalogLoad &&
                    remoteEpgCatalog.signature === catalogSignature
                        ? remoteEpgCatalog.revision
                        : Date.now().toString(36) +
                          "-" +
                          Math.random().toString(36).slice(2);
                remoteEpgCatalog = {
                    expires: Date.now() + 120000,
                    load: catalogLoad,
                    revision: revision,
                    signature: catalogSignature,
                    source: catalogSource,
                    token:
                        Date.now().toString(36) +
                        "-" +
                        Math.random().toString(36).slice(2),
                };
            }
            reply({
                archive: { revision: remoteEpgCatalog.revision, version: 1 },
                catalog: remoteEpgCatalog.token,
                channels: metadata,
            });
            return;
        }
        if (
            Object.keys(params).length !==
                (request.action === "play_catalog" ? 2 : 5) ||
            typeof params.catalog !== "string" ||
            typeof params.id !== "string" ||
            !receiptCurrent() ||
            params.catalog !== remoteEpgCatalog.token
        ) {
            reject(
                "Channels or provider changed. Retry the EPG query before playing."
            );
            return;
        }
        var selected = rows.filter(function (row: any) {
            return String(row.id) === params.id;
        });
        if (selected.length !== 1) {
            reject("The selected EPG channel is no longer available.");
            return;
        }
        selected[0].id = params.id;
        if (request.action !== "play_catalog") {
            handleRemoteArchive(
                w,
                request,
                selected[0],
                receiptCurrent,
                reply,
                reject
            );
            return;
        }
        // Reuse channel admission/category handling, after binding the request to
        // the exact ordered catalogue that the remote EPG result described.
        request = {
            action: "play",
            params: { query: String(selected[0].number) },
        };
        params = request.params;
    }
    if (request.action === "channels") {
        var channelSearch = caselessKey(String(params.search || ""));
        reply({
            channels: rows.filter(function (row) {
                return includes(row.name, channelSearch);
            }),
        });
        return;
    }
    if (request.action === "play") {
        var text = String(params.query).trim();
        var playSearch = caselessKey(text);
        var matches = /^\d+$/.test(text)
            ? rows.filter(function (row) {
                  return row.number === Number(text);
              })
            : rows.filter(function (row) {
                  return caselessKey(row.name) === playSearch;
              });
        if (!matches.length && !/^\d+$/.test(text))
            matches = rows.filter(function (row) {
                return includes(row.name, playSearch);
            });
        if (matches.length !== 1) {
            reject(
                matches.length
                    ? "Several channels match. Use a channel number."
                    : "Channel not found.",
                matches
            );
            return;
        }
        for (var c = 0; c < (w.catsArray || []).length; c++) {
            var list = w.cats[w.catsArray[c]] || [];
            for (var i = 0; i < list.length; i++) {
                if (String(list[i]) === String(matches[0].id)) {
                    if (typeof w.playChannel !== "function") {
                        reject("Playback is unavailable.");
                        return;
                    }
                    if (w.playChannel(c, i, true) === false) {
                        reject("Playback was rejected by the player.");
                        return;
                    }
                    reply({ channel: matches[0], dispatched: true });
                    return;
                }
            }
        }
        reject("Channel is unavailable in the current categories.");
        return;
    }
    if (request.action !== "programs") {
        done({
            data: { error: "Unsupported request." },
            status: "unsupported",
        });
        return;
    }
    var guide = w.__ottClassicGuide;
    if (!guide) {
        done({
            data: { error: "This player has no EPG query service." },
            status: "unsupported",
        });
        return;
    }
    var source = guide.source();
    var channelLoad = w.__ottCommandChannelLoad;
    var asOf = Date.now() / 1000;
    var programSearch = caselessKey(String(params.search || ""));
    var programs: any[] = [];
    var position = 0,
        running = 0,
        checked = 0;
    var stopped = false;
    var pumpTimer: any = null;
    var cancels: Array<() => void> = [];
    function cancel(): void {
        stopped = true;
        w.clearTimeout(timer);
        w.clearTimeout(pumpTimer);
        pumpTimer = null;
        cancels.forEach(function (fn) {
            fn();
        });
    }
    function changed(): boolean {
        return (
            source !== guide.source() ||
            channelLoad !== w.__ottCommandChannelLoad ||
            w.commandChannelsReady !== true
        );
    }
    function finish(): void {
        if (stopped) return;
        var stale = changed();
        cancel();
        if (stale || changed()) {
            reject("Channels or provider changed while reading EPG. Retry.");
            return;
        }
        reply({
            as_of: asOf,
            checked: checked,
            partial: checked < rows.length,
            programs: programs.sort(function (a, b) {
                return a.number - b.number;
            }),
            total: rows.length,
        });
    }
    var timer = w.setTimeout(finish, 25000);
    function consume(row: any, entries: any): void {
        checked++;
        if (!entries || !entries.length) return;
        var current = w.OttPlayCore.guideScheduleSelection(
            entries.map(function (entry: any) {
                return { end: entry.time_to, row: entry, start: entry.time };
            }),
            asOf,
            0
        ).current;
        if (!current || !current.row.name) return;
        var entry = current.row;
        if (includes(String(entry.name), programSearch))
            programs.push({
                channel: row.name,
                end: entry.time_to,
                number: row.number,
                start: entry.time,
                title: String(entry.name),
            });
    }
    function schedulePump(): void {
        if (stopped || pumpTimer !== null) return;
        pumpTimer = w.setTimeout(function () {
            pumpTimer = null;
            pump();
        }, 0);
    }
    // Yield between batches even when cached callbacks complete synchronously.
    function pump(): void {
        if (stopped) return;
        if (changed()) {
            finish();
            return;
        }
        var batch = 0;
        while (
            !stopped &&
            running < 4 &&
            position < rows.length &&
            batch++ < 64
        ) {
            (function (row) {
                var cached = guide.peek(row.id);
                if (cached && cached.length) {
                    consume(row, cached);
                    return;
                }
                running++;
                var completed = false;
                var release = guide.request(
                    row.id,
                    function (_id: any, entries: any) {
                        if (completed || stopped) return;
                        completed = true;
                        running--;
                        consume(row, entries);
                        schedulePump();
                    }
                );
                cancels.push(release);
            })(rows[position++]);
        }
        if (!running && position === rows.length) finish();
        else if (running < 4 && position < rows.length) schedulePump();
    }
    pump();
    return cancel;
}
