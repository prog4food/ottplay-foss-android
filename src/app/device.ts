/**
 * Device detection module.
 *
 * Detects device type from URL path, user agent and native API availability.
 * Exports globals expected by legacy code and provider scripts.
 */

// Keep in sync with the pre-bundle device detector in index.html.
export function detectDevice(): string {
    var path = window.location.pathname;
    var m = path.match(/^\/f\/((?:lg|samsung)\/[^\/]+|[^\/]+)(?:\/|$)/);
    if (m) return m[1].replace(/\/+$/, "");
    var ua = navigator.userAgent.toLowerCase();
    if (ua.indexOf("web0s") !== -1 || ua.indexOf("webos") !== -1)
        return "lg/webos";
    // NetCast also advertises LG; keep explicit webOS ahead of compatibility tokens.
    if (ua.indexOf("netcast") !== -1) return "lg/netcast";
    if (ua.indexOf("lg") !== -1) return "lg/webos";
    // Probe the bridge shape only: native calls may fail before initialization.
    try {
        var gstb = (window as any).gSTB;
        if (
            gstb &&
            (typeof gstb.GetDeviceModel === "function" ||
                typeof gstb.GetDeviceMacAddress === "function" ||
                typeof gstb.GetMACAddress === "function")
        )
            return "mag";
    } catch (_error) {
        // An unavailable native bridge must not prevent user-agent fallback.
    }
    // MAG profiles may omit Infomir or include Maple as a compatibility token.
    if (
        /(?:^|[^a-z0-9])mag[0-9]+(?:[rw][0-9]+)?(?:$|[^a-z0-9])/.test(ua) ||
        (ua.indexOf("stb") !== -1 && ua.indexOf("infomir") !== -1)
    )
        return "mag";
    if (ua.indexOf("tizen") !== -1) return "samsung/tizen";
    if (ua.indexOf("maple") !== -1) return "samsung/maple";
    if (ua.indexOf("dune") !== -1) return "dune";
    if (ua.indexOf("android") !== -1) return "android";
    if (ua.indexOf("hbbtv") !== -1 || ua.indexOf("oipf") !== -1) return "hbbtv";
    if (ua.indexOf("viera") !== -1) return "panasonic";
    if (ua.indexOf("philips") !== -1) return "philips";
    if (ua.indexOf("hisense") !== -1) return "hisense";
    if (ua.indexOf("sony") !== -1) return "sony";
    if (ua.indexOf("tcl") !== -1) return "tcl";
    if (ua.indexOf("sharp") !== -1) return "sharp";
    if (ua.indexOf("toshiba") !== -1) return "toshiba";
    if (ua.indexOf("skyworth") !== -1) return "skyworth";
    if (ua.indexOf("vewd") !== -1) return "vewd";
    if (ua.indexOf("spark") !== -1) return "spark";
    if (ua.indexOf("nodejs") !== -1 || ua.indexOf("electron") !== -1)
        return "nodejs";
    return "pc";
}

/**
 * Global variables expected by legacy code and provider scripts.
 * Initialize these during bundle evaluation, before HTML loads the device
 * adapter and calls startPlayer(). detectDevice() always returns a nonempty route.
 */

export let host = window.location.origin || "http://localhost:8080";
export let __cv = (window as any).__cv || "local";
export let __av = (window as any).__av || "local";
export let dnt = false;
export let ott_device: string = detectDevice();
