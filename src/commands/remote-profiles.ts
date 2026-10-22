import { checkProviderUrl, isProviderAllowed } from "../provider";

// Configuration publication can synchronously reenter the remote dispatcher.
var profileRequestActive = false;

/** Compare saved bytes without selecting a provider or returning its secrets. */
export function compareRemoteSettings(w: any, params: any): any {
    function object(value: any): boolean {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }
    function fail(): any {
        return {
            data: { error: "Settings comparison is unavailable or invalid." },
            status: "rejected",
        };
    }
    function boundedText(value: any, maximum: number): boolean {
        if (
            typeof value !== "string" ||
            value.length > maximum ||
            /[\u0000-\u001f\u007f]/.test(value)
        )
            return false;
        try {
            return (
                encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x")
                    .length <= maximum
            );
        } catch (_) {
            return false;
        }
    }
    if (!object(params) || !object(params.settings)) return fail();
    var provider = params.provider;
    var schemas: Record<string, string[]> = {
        m3u: ["history_hours", "name", "playlist"],
        plex: ["server", "token"],
        stalker: ["mac", "name", "server"],
    };
    if (!Object.prototype.hasOwnProperty.call(schemas, provider)) return fail();
    var numbered = provider !== "plex";
    if (
        Object.keys(params).sort().join(",") !==
            (numbered ? "number,provider,settings" : "provider,settings") ||
        Object.keys(params.settings).sort().join(",") !==
            schemas[provider].join(",") ||
        (numbered &&
            (typeof params.number !== "number" ||
                params.number < 1 ||
                params.number > 15 ||
                Math.floor(params.number) !== params.number))
    )
        return fail();
    if (
        w.__ottParental
            ? w.__ottParental.needs("providers") ||
              w.__ottParental.needs("settings")
            : (w.sPSprovs || w.sPSoptions) &&
              w.parentPIN !== "*" &&
              !w.parentAccess
    )
        return fail();
    var expected = params.settings;
    if (
        schemas[provider].some(function (key) {
            return key === "history_hours"
                ? typeof expected[key] !== "number" ||
                      !isFinite(expected[key]) ||
                      Math.floor(expected[key]) !== expected[key] ||
                      expected[key] < 0 ||
                      expected[key] > 8760
                : !boundedText(
                      expected[key],
                      key === "name"
                          ? 256
                          : key === "token"
                            ? 1024
                            : key === "mac"
                              ? 17
                              : 8192
                  );
        })
    )
        return fail();
    try {
        var key =
            provider === "m3u"
                ? "m3um3uArr"
                : provider === "plex"
                  ? "plexcfg"
                  : "stalkerstalker_data";
        var raw = w.stbGetItem(key);
        var saved = raw ? JSON.parse(raw) : {};
        var actual: any;
        if (provider === "m3u") {
            var slot = (saved.M3Us || [])[params.number - 1] || {};
            actual = {
                history_hours: Number(slot.rechours || 0),
                name: slot.name || "",
                playlist: slot.www || "",
            };
        } else if (provider === "stalker") {
            var portal =
                (Array.isArray(saved.portals) ? saved.portals : [saved])[
                    params.number - 1
                ] || {};
            actual = {
                mac: portal.mac || "",
                name: portal.name || "",
                server: portal.portal || "",
            };
        } else {
            actual = {
                server: saved.address || saved.server || "",
                token: saved.token || "",
            };
            expected = {
                server: expected.server.trim().replace(/\/+$/, ""),
                token: expected.token.trim(),
            };
        }
        var matched = schemas[provider].every(function (field) {
            return actual[field] === expected[field];
        });
        // Reentrant/native reads must not certify a value replaced during the comparison.
        if (w.stbGetItem(key) !== raw) return fail();
        var data: any = { matched: matched, provider: provider };
        if (numbered) data.number = params.number;
        return { data: data, status: "ok" };
    } catch (_) {
        return fail();
    }
}

/** Handle managed profile operations without returning endpoints or credentials. */
export function handleRemoteProfiles(
    request: any,
    done: (result: any) => void
): boolean {
    var action = request.action;
    if (action === "settings_compare") {
        done(compareRemoteSettings(window, request.params));
        return true;
    }
    var offline = (window as any).__ottOfflineProfiles;
    if (
        offline &&
        (window as any).__ottActiveProviderDriver &&
        (window as any).__ottActiveProviderDriver.id === "offline" &&
        [
            "profiles",
            "profile",
            "profile_save",
            "profile_export",
            "profile_import",
        ].indexOf(action) >= 0
    ) {
        offline.request(request).then(done);
        return true;
    }
    if (
        [
            "profiles",
            "profile",
            "profile_settings",
            "profile_save",
            "profile_export",
            "profile_import",
        ].indexOf(action) < 0
    )
        return false;
    function rejected(message: string): any {
        return { data: { error: message }, status: "rejected" };
    }
    if (profileRequestActive) {
        done(rejected("Another profile operation is in progress."));
        return true;
    }
    var w = window as any;
    function object(value: any): boolean {
        return !!value && typeof value === "object" && !Array.isArray(value);
    }
    function bytes(value: string): number {
        return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "x").length;
    }
    function text(value: any, maximum: number): boolean {
        return (
            typeof value === "string" &&
            value.length <= maximum &&
            !/[\u0000-\u001f\u007f]/.test(value) &&
            bytes(value) <= maximum
        );
    }
    function name(value: any): string {
        var result = String(value || "")
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .slice(0, 256);
        // Old UI settings had no length bound; keep the metadata receipt small.
        while (result) {
            try {
                if (bytes(result) <= 256) return result;
            } catch (_) {}
            result = result.slice(0, -1);
        }
        return "";
    }
    function historyHours(value: any): number | null {
        var hours =
            typeof value === "string" && !/^\d*$/.test(value.trim())
                ? NaN
                : Number(value);
        return isFinite(hours) &&
            Math.floor(hours) === hours &&
            hours >= 0 &&
            hours <= 8760
            ? hours
            : null;
    }
    function metadata(config: any, index: number): any {
        var slot = config.M3Us[index];
        return {
            active: config.active === index,
            history_hours: historyHours(slot.rechours),
            name: name(slot.name),
            number: index + 1,
            playlist_configured: !!slot.www.trim(),
        };
    }
    function locked(): boolean {
        return w.__ottParental
            ? w.__ottParental.needs("providers") ||
                  w.__ottParental.needs("settings")
            : !!(
                  (w.sPSprovs || w.sPSoptions) &&
                  w.parentPIN !== "*" &&
                  !w.parentAccess
              );
    }
    function playlistAllowed(value: string): boolean {
        if (!value) return true;
        var parsed = new URL(value);
        return (
            /^https?:\/\//i.test(value) &&
            /^https?:$/.test(parsed.protocol) &&
            !!parsed.hostname &&
            !parsed.username &&
            !parsed.password &&
            !/[\\\s]/.test(value) &&
            checkProviderUrl(parsed.href)
        );
    }
    function run(): any {
        var params = request.params === undefined ? {} : request.params;
        var driver = w.__ottActiveProviderDriver;
        if (
            driver &&
            driver.id === "vportal" &&
            isProviderAllowed("vportal") &&
            typeof driver.remoteProfiles === "function"
        )
            return driver.remoteProfiles(request);
        if (
            !driver ||
            driver.id !== "m3u" ||
            typeof driver.configuration !== "function" ||
            typeof driver.saveConfiguration !== "function" ||
            typeof driver.fixedSlot !== "function" ||
            !isProviderAllowed("m3u")
        )
            return rejected(
                "Select the M3U provider before managing profiles."
            );
        if (!object(params)) return rejected("Invalid profile parameters.");
        var config = driver.configuration();
        var before = JSON.stringify(config);
        if (
            !config ||
            !Array.isArray(config.M3Us) ||
            config.M3Us.length !== 15 ||
            typeof config.active !== "number" ||
            Math.floor(config.active) !== config.active ||
            config.active < 0 ||
            config.active >= 15
        )
            return rejected("The M3U profile configuration is unavailable.");
        if (action === "profiles") {
            if (Object.keys(params).length)
                return rejected("The profiles query accepts no parameters.");
            return {
                data: {
                    profiles: config.M3Us.map(function (
                        _slot: any,
                        index: number
                    ) {
                        return metadata(config, index);
                    }),
                    provider: "m3u",
                },
                status: "ok",
            };
        }
        if (locked())
            return rejected("Unlock provider settings on the player first.");
        var keys = Object.keys(params);
        var number = params.number;
        if (
            typeof number !== "number" ||
            !isFinite(number) ||
            Math.floor(number) !== number ||
            number < 1 ||
            number > 15 ||
            keys.length !== (action === "profile" ? 1 : 2) ||
            keys.some(function (key) {
                return (
                    key !== "number" &&
                    !(action === "profile_settings" && key === "settings")
                );
            })
        )
            return rejected("Choose a profile number from 1 to 15.");
        var index = number - 1;
        var fixed = driver.fixedSlot();
        if (fixed >= 0 && fixed !== index)
            return rejected("This player URL is restricted to one profile.");
        var slot = config.M3Us[index];
        var fields: string[] = [];
        var reload = false;
        if (action === "profile") {
            if (!slot.www.trim())
                return rejected(
                    "Configure this profile's playlist before selecting it."
                );
            if (!checkProviderUrl(slot.www))
                return rejected(
                    "This playlist is not allowed on this platform."
                );
            reload = config.active !== index;
            config.active = index;
        } else {
            if (!object(params.settings))
                return rejected("Provide profile settings to change.");
            fields = Object.keys(params.settings);
            if (
                !fields.length ||
                fields.some(function (key) {
                    return (
                        ["name", "playlist", "history_hours"].indexOf(key) < 0
                    );
                })
            )
                return rejected("Unsupported profile settings fields.");
            for (var at = 0; at < fields.length; at++) {
                var field = fields[at];
                var value = params.settings[field];
                var target =
                    field === "playlist"
                        ? "www"
                        : field === "history_hours"
                          ? "rechours"
                          : "name";
                if (field === "history_hours") {
                    if (
                        typeof value !== "number" ||
                        !isFinite(value) ||
                        Math.floor(value) !== value ||
                        value < 0 ||
                        value > 8760
                    )
                        return rejected(
                            "Use whole archive hours from 0 to 8760."
                        );
                } else if (!text(value, field === "name" ? 256 : 8192))
                    return rejected(
                        "Profile text exceeds its UTF-8 limit or contains invalid characters."
                    );
                if (field === "playlist" && !playlistAllowed(value))
                    return rejected("Use a valid HTTP(S) playlist URL.");
                var changed =
                    field === "history_hours"
                        ? historyHours(slot[target]) !== value
                        : String(slot[target] || "") !== value;
                if (!changed) continue;
                slot[target] = value;
                if (
                    config.active === index &&
                    (field === "playlist" || field === "history_hours")
                )
                    reload = true;
            }
        }
        var changed = JSON.stringify(config) !== before;
        var load = w.loadPlaylist;
        if (reload && typeof load !== "function")
            return rejected("The playlist reload lifecycle is unavailable.");
        // URL policy checks can open a modal; do not overwrite a synchronous
        // provider/slot change or an intervening settings write.
        if (
            w.__ottActiveProviderDriver !== driver ||
            driver.id !== "m3u" ||
            locked() ||
            driver.fixedSlot() !== fixed ||
            JSON.stringify(driver.configuration()) !== before
        )
            return rejected(
                "The profile changed during validation. Try again."
            );
        if (changed) {
            var expected = JSON.parse(JSON.stringify(config));
            if (
                driver.saveConfiguration(config) !== true ||
                w.__ottActiveProviderDriver !== driver
            )
                return rejected("Could not complete the profile save.");
            var persisted = driver.configuration();
            if (JSON.stringify(persisted) !== JSON.stringify(expected))
                return rejected("The profile changed while saving. Try again.");
            config = persisted;
            if (reload) {
                if (w.loadPlaylist !== load)
                    return rejected(
                        "The playlist reload lifecycle changed while saving."
                    );
                load();
                if (
                    w.__ottActiveProviderDriver !== driver ||
                    JSON.stringify(driver.configuration()) !==
                        JSON.stringify(config)
                )
                    return rejected(
                        "The profile changed while reloading. Try again."
                    );
            }
        }
        var data: any = {
            profile: metadata(config, index),
            provider: "m3u",
            reloaded: changed && reload,
        };
        if (action === "profile") data.dispatched = true;
        else {
            data.fields = fields;
            data.saved = true;
        }
        return { data: data, status: "ok" };
    }
    profileRequestActive = true;
    var result: any;
    try {
        result = run();
    } catch (_) {
        result = rejected("Could not validate or save this profile.");
    } finally {
        profileRequestActive = false;
    }
    done(result);
    return true;
}
