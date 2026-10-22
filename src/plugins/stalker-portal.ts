import { nativePromiseToJq } from "./jquery-bridge";
import { resolveNativePlugin, tauriInvoke } from "./native-bridge";
import { nativeWebFallback } from "./web-fallback";

/**
 * Stalker portal + host_ott swop shim — Mode B native HTTP transport.
 *
 * Covers:
 * - Stalker provider scripts (`providers/stalker/provider.js`) POST JSON-RPC to
 *   `<portal>/stalker_portal/api/` (and `/stalker_portal/stream/` text).
 * - Dealer/cloud entry (`edit_dealer_remote`, cloud settings) POST
 *   form-urlencoded bodies to `host_ott/swop/a.php`.
 * - Classic MAG requests from the managed Stalker provider forward Cookie /
 *   Authorization through the same native transport, including portal.php.
 *
 * Native apps have no companion HTTP server and WebView CORS blocks those
 * origins. This module:
 * - exposes Capacitor `StalkerPortal.portalRequest` (native HTTP);
 * - `setupStalkerPortalShim()` intercepts jQuery `$.ajax` for the paths
 *   above and routes through Tauri `stalker_portal_fetch` or Cap
 *   `portalRequest`;
 * - forwards ajax `headers` (Authorization / Cookie / …) and merges
 *   returned `Set-Cookie` into a Mode-B-only in-memory jar per host.
 *
 * Mode A (browser + companion) never installs this shim.
 * Hard rule: never fake a successful portal/swop/Mag response.
 */

export interface StalkerPortalPlugin {
    cancelHttpRequest?(opts: {
        requestId: string;
    }): Promise<{ cancelled: boolean }>;
    /** Generic raw-text HTTP for provider JSON/JSONP requests in the native app. */
    httpRequest(opts: {
        url: string;
        method: string;
        body?: string;
        headers?: Record<string, string>;
        timeoutMs?: number;
        requestId?: string;
        screenshotControl?: boolean;
        remoteControl?: boolean;
    }): Promise<NativeHttpResponse>;
    portalRequest(opts: {
        url: string;
        method?: string;
        body?: string;
        contentType?: string;
        headers?: Record<string, string>;
        requestId?: string;
        timeoutMs?: number;
    }): Promise<{
        status: number;
        body: string;
        contentType: string;
        setCookie?: string[];
    }>;
    /** Dedicated bounded SWOP relay request; never uses provider cookies. */
    swopRequest(opts: {
        url: string;
        body: string;
        clientId: string;
    }): Promise<NativeHttpResponse>;
}

class StalkerPortalWeb implements StalkerPortalPlugin {
    swopRequest(): Promise<NativeHttpResponse> {
        return nativeWebFallback(function () {
            throw new Error("Native SWOP unavailable");
        });
    }
    httpRequest(): Promise<NativeHttpResponse> {
        return nativeWebFallback(function () {
            throw new Error(
                "[StalkerPortal] native HTTP unavailable (web fallback)"
            );
        });
    }
    portalRequest(_opts: {
        url: string;
        method?: string;
        body?: string;
        contentType?: string;
        headers?: Record<string, string>;
    }): Promise<{
        status: number;
        body: string;
        contentType: string;
        setCookie?: string[];
    }> {
        return nativeWebFallback(function () {
            // Web fallback must not pretend the portal answered.
            throw new Error(
                "[StalkerPortal] native plugin unavailable (web fallback)"
            );
        });
    }
}

const StalkerPortal = resolveNativePlugin<StalkerPortalPlugin>(
    "StalkerPortal",
    () => new StalkerPortalWeb()
);

function isStalkerPortalUrl(url: string): boolean {
    return (
        url.indexOf("/stalker_portal/api/") !== -1 ||
        url.indexOf("/stalker_portal/stream/") !== -1
    );
}

/** STB dealer/cloud handshake endpoint (`host_ott_proto + host_ott + /swop/a.php`). */
function isHostOttSwopUrl(url: string): boolean {
    return url.indexOf("/swop/a.php") !== -1;
}

/**
 * Classic MAG / Ministra requests from the shared-core provider client.
 */
function isMagLoadPhpUrl(url: string): boolean {
    return (
        url.indexOf("/load.php") !== -1 ||
        url.indexOf("/portal.php") !== -1 ||
        url.indexOf("/c/portal") !== -1
    );
}

function isShimmedUrl(url: string): boolean {
    return (
        isStalkerPortalUrl(url) || isHostOttSwopUrl(url) || isMagLoadPhpUrl(url)
    );
}

/**
 * Install `$.ajax` wrapper that routes Stalker portal + host_ott swop + Mag
 * path-shaped URLs through native transport. Other URLs keep the previous
 * ajax implementation (Mode B companion shim or raw jQuery).
 */
export function setupStalkerPortalShim(): void {
    const $ = (window as any).$;
    if (
        !$ ||
        typeof $.ajax !== "function" ||
        typeof $.Deferred !== "function"
    ) {
        console.warn("[Stalker] shim: jQuery ajax unavailable");
        return;
    }
    if ((window as any).__ottStalkerPortalShim) return;
    (window as any).__ottStalkerPortalShim = true;
    const origAjax = $.ajax.bind($);

    /** Mode-B-only cookie jar: host → cookie-pair map (name → name=value). */
    type CookieJar = Record<string, Record<string, string>>;

    function getCookieJar(): CookieJar {
        const w = window as any;
        if (!w.__ottStalkerCookieJar) w.__ottStalkerCookieJar = {};
        return w.__ottStalkerCookieJar as CookieJar;
    }

    function hostKeyFromUrl(url: string): string {
        try {
            const u = new URL(url);
            return u.protocol + "//" + u.host;
        } catch (_e) {
            return url;
        }
    }

    function parseSetCookieToPairs(
        setCookie: string[]
    ): Record<string, string> {
        const out: Record<string, string> = {};
        for (const raw of setCookie || []) {
            if (!raw) continue;
            const first = String(raw).split(";")[0].trim();
            const eq = first.indexOf("=");
            if (eq <= 0) continue;
            const name = first.slice(0, eq).trim();
            if (!name) continue;
            out[name] = first;
        }
        return out;
    }

    function mergeSetCookie(
        url: string,
        setCookie: string[] | undefined
    ): void {
        if (!setCookie || !setCookie.length) return;
        const jar = getCookieJar();
        const host = hostKeyFromUrl(url);
        if (!jar[host]) jar[host] = {};
        const pairs = parseSetCookieToPairs(setCookie);
        for (const name of Object.keys(pairs)) {
            jar[host][name] = pairs[name];
        }
    }

    function cookieHeaderForUrl(url: string): string {
        const jar = getCookieJar();
        const host = hostKeyFromUrl(url);
        const map = jar[host];
        if (!map) return "";
        const parts: string[] = [];
        for (const name of Object.keys(map)) {
            parts.push(map[name]);
        }
        return parts.join("; ");
    }

    /**
     * Encode ajax `data` the way jQuery would for the target URL.
     * Stalker JSON-RPC uses JSON bodies; swop/a.php uses form-urlencoded
     * (jQuery default for object `data` without `contentType: application/json`).
     * Mag load.php callers typically pass query strings / form bodies themselves.
     */
    function encodeAjaxBody(
        opts: any,
        url: string
    ): { body: string | undefined; contentType: string } {
        const swop = isHostOttSwopUrl(url);
        const mag = isMagLoadPhpUrl(url);
        const explicitCt =
            typeof opts.contentType === "string" ? opts.contentType : "";
        const defaultCt = swop
            ? "application/x-www-form-urlencoded; charset=UTF-8"
            : mag
              ? "application/x-www-form-urlencoded; charset=UTF-8"
              : "application/json";
        const contentType = explicitCt || defaultCt;

        if (typeof opts.data === "string") {
            return { body: opts.data, contentType };
        }
        if (opts.data == null) {
            return { body: undefined, contentType };
        }
        if (typeof opts.data === "object") {
            const wantForm =
                swop ||
                mag ||
                contentType.indexOf("application/x-www-form-urlencoded") !== -1;
            if (wantForm) {
                const $ = (window as any).$;
                try {
                    if ($ && typeof $.param === "function") {
                        return { body: $.param(opts.data), contentType };
                    }
                } catch (_e) {}
                // Minimal fallback if $.param missing
                try {
                    const parts: string[] = [];
                    for (const key of Object.keys(opts.data)) {
                        const val = opts.data[key];
                        parts.push(
                            encodeURIComponent(key) +
                                "=" +
                                encodeURIComponent(
                                    val == null ? "" : String(val)
                                )
                        );
                    }
                    return { body: parts.join("&"), contentType };
                } catch (_e2) {
                    return { body: undefined, contentType };
                }
            }
            try {
                return { body: JSON.stringify(opts.data), contentType };
            } catch (_e3) {
                return { body: undefined, contentType };
            }
        }
        return { body: undefined, contentType };
    }

    /** Collect ajax headers + jar Cookie when caller did not set Cookie. */
    function collectRequestHeaders(
        opts: any,
        url: string
    ): Record<string, string> | undefined {
        const out: Record<string, string> = {};
        const src = opts.headers;
        if (src && typeof src === "object") {
            for (const key of Object.keys(src)) {
                const val = src[key];
                if (val == null) continue;
                out[key] = String(val);
            }
        }
        const hasCookie = Object.keys(out).some(
            (k) => k.toLowerCase() === "cookie"
        );
        if (!hasCookie) {
            const fromJar = cookieHeaderForUrl(url);
            if (fromJar) out.Cookie = fromJar;
        }
        return Object.keys(out).length ? out : undefined;
    }

    function parseResponseBody(
        body: string,
        opts: any,
        url: string,
        respContentType: string
    ): any {
        const wantJson =
            opts.dataType === "json" ||
            isHostOttSwopUrl(url) ||
            (respContentType &&
                respContentType.indexOf("application/json") !== -1);
        if (wantJson && typeof body === "string" && body) {
            try {
                return JSON.parse(body);
            } catch (_e) {
                return body;
            }
        }
        return body;
    }

    $.ajax = function (urlOrOpts: any, maybeOpts?: any): any {
        if ((window as any).__ottStandby?.blocked())
            return origAjax(urlOrOpts, maybeOpts);
        let opts: any;
        if (typeof urlOrOpts === "string") {
            opts = Object.assign({ url: urlOrOpts }, maybeOpts || {});
        } else {
            opts = Object.assign({}, urlOrOpts || {});
        }
        const url = String(opts.url || "");

        if (!isShimmedUrl(url)) {
            return origAjax(urlOrOpts, maybeOpts);
        }

        const method = String(opts.type || opts.method || "GET").toUpperCase();
        const encoded = encodeAjaxBody(opts, url);
        const body = encoded.body;
        const contentType = encoded.contentType;
        const headers = collectRequestHeaders(opts, url);

        const isTauri = typeof (window as any).__TAURI__ !== "undefined";

        const request = { body, contentType, headers, method, url };
        const response = isTauri
            ? tauriInvoke<{
                  status: number;
                  body: string;
                  contentType: string;
                  setCookie?: string[];
              }>("stalker_portal_fetch", request)
            : StalkerPortal.portalRequest(request);
        return nativePromiseToJq(
            $,
            response.then((res) => {
                mergeSetCookie(url, res.setCookie);
                if (!(res.status >= 200 && res.status < 300)) {
                    throw new Error(
                        "stalker HTTP " +
                            res.status +
                            ": " +
                            (res.body || "").slice(0, 200)
                    );
                }
                return parseResponseBody(
                    res.body || "",
                    opts,
                    url,
                    res.contentType || ""
                );
            }),
            opts,
            "portalRequest failed"
        );
    };
}

export {
    isHostOttSwopUrl,
    isMagLoadPhpUrl,
    isShimmedUrl,
    isStalkerPortalUrl,
    StalkerPortal,
};
