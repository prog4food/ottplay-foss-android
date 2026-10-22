/** Source identity excludes display names and transient stream addresses. */
function sourceNamespace(host: any): string {
    var driver = host.__ottActiveProviderDriver;
    var provider = String(
        host.p_pref || (driver && driver.id) || host.providerId || "classic"
    );
    if (
        provider === "offline" &&
        host.__ottOfflineProfiles &&
        typeof host.__ottOfflineProfiles.namespace === "function"
    )
        return host.__ottOfflineProfiles.namespace();
    var slot = Number(host.m3uArr && host.m3uArr.active);
    if (provider === "vportal" && driver && driver.configuration)
        return provider + ":" + driver.configuration().active;
    if (provider === "stalker" && driver && driver.configuration) {
        var active = driver.configuration().active;
        // Preserve the original singleton namespace for its migrated first slot.
        return active ? provider + ":" + active : provider;
    }
    return provider === "m3u"
        ? provider +
              ":" +
              (isFinite(slot) && slot >= 0 && Math.floor(slot) === slot
                  ? slot
                  : 0)
        : provider;
}

function sourceIdentity(host: any, media?: boolean): string {
    var namespace = sourceNamespace(host);
    var driver = host.__ottActiveProviderDriver;
    var config: any = null;
    try {
        config =
            driver && typeof driver.credentials === "function"
                ? driver.credentials()
                : null;
    } catch (_) {}
    var slot =
        namespace.indexOf("m3u:") === 0 && host.m3uArr && host.m3uArr.M3Us
            ? host.m3uArr.M3Us[Number(namespace.slice(4))]
            : null;
    var parts = slot
        ? [slot.www || ""]
        : config
          ? [
                driver && driver.id === "plex" && config.plexAccount
                    ? config.plexAccount.id
                    : config.server || "",
                config.username || "",
                !media && driver && typeof driver.mediaSource === "function"
                    ? ""
                    : config.playlist || "",
                // Token-only providers have no account name. A token identifies that account.
                config.username ? "" : config.password || "",
            ]
          : [];
    try {
        if (media && slot) parts.push(slot.medSourceId || "");
        if (media && driver && typeof driver.mediaSource === "function")
            parts.push(driver.mediaSource());
    } catch (_) {}
    if (!parts.join("")) return namespace;
    // Two independent 32-bit accumulators avoid retaining account URLs/tokens in storage keys.
    // This is a namespace fingerprint, not a credential protection or authentication primitive.
    var input = JSON.stringify(parts);
    var first = 2166136261;
    var second = 5381;
    for (var i = 0; i < input.length; i++) {
        first ^= input.charCodeAt(i);
        first +=
            (first << 1) +
            (first << 4) +
            (first << 7) +
            (first << 8) +
            (first << 24);
        second = ((second << 5) + second) ^ input.charCodeAt(i);
    }
    return (
        namespace +
        "@" +
        (first >>> 0).toString(16) +
        "." +
        (second >>> 0).toString(16)
    );
}

(window as any).__ottSourceIdentity = {
    current: sourceIdentity,
    legacy: sourceNamespace,
    media: function (host: any) {
        return sourceIdentity(host, true);
    },
};
