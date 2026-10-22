/**
 * Helper utilities ported from stbPlayer.js.
 *
 * Collection of small, commonly-used functions for DOM manipulation,
 * performance logging, feedback POST, time formatting, and script loading.
 */

/**
 * Send a client feedback message to the default `/report_feedb` endpoint.
 *
 * @param message - The message string to report.
 *
 * @sideEffects
 * Delegates to `queueFeedbackPost()` which buffers and asynchronously POSTs
 * feedback data to the server.
 */
export function sendClientFeedback(message: string): void {
    queueFeedbackPost(message, "/report_feedb");
}

var sendFeedback: (msg: string) => void = function (msg: string): void {
    queueFeedbackPost(msg, "/report_feedb");
};

/**
 * Batched feedback POST system.
 *
 * Buffers feedback messages and sends them in a single AJAX POST after a
 * 5-second debounce period. Resets the timer on each new submission.
 *
 * @param data     - The feedback payload (any JSON-serializable value).
 * @param endpoint - Optional target path (defaults to `'/report_feedb'`).
 *
 * @sideEffects
 * - Appends to the internal `_fbBuffer` array.
 * - Sets / resets `_fbTimer` via `setTimeout`.
 * - On flush, performs an AJAX POST request to `{host}/api/feedback`
 *   using jQuery (`$.ajax`) if available.
 */
export function queueFeedbackPost(data: any, endpoint?: string): void {
    try {
        _fbBuffer.push({
            msg: data,
            path: endpoint || "/report_feedb",
            ts: Date.now(),
        });
        if (_fbTimer === null) {
            _fbTimer = setTimeout(function () {
                _fbTimer = null;
                var batch = _fbBuffer.splice(0, _fbBuffer.length);
                if (batch.length === 0) return;
                var base =
                    typeof (window as any).host === "string"
                        ? (window as any).host
                        : "";
                try {
                    if (typeof $ !== "undefined" && $.ajax) {
                        $.ajax({
                            contentType: "application/json",
                            data: JSON.stringify(batch),
                            timeout: 3000,
                            type: "POST",
                            url: base + "/api/feedback",
                        });
                    }
                } catch (_e) {}
            }, 5000);
        }
    } catch (_e) {}
}
var _fbBuffer: any[] = [];
var _fbTimer: any = null;

/**
 * Compute the current window width relative to a 1280-pixel baseline.
 *
 * @returns The ratio `window.innerWidth / 1280`.
 *
 * @remarks
 * Used for responsive scaling of UI elements in an STB environment where
 * 1280×720 is the reference resolution.
 */
export function getViewportWidthScale(): number {
    return window.innerWidth / 1280;
}

/**
 * Compute the current window height relative to a 720-pixel baseline.
 *
 * @returns The ratio `window.innerHeight / 720`.
 *
 * @remarks
 * Used for responsive scaling of UI elements in an STB environment where
 * 1280×720 is the reference resolution.
 */
export function getViewportHeightScale(): number {
    return window.innerHeight / 720;
}

/** Shared video/mask geometry on the 1280 x 720 design canvas. */
export function listPreviewRect(
    theme: number,
    mirrored: number
): {
    height: number;
    left: number;
    top: number;
    width: number;
} {
    var width = theme === 2 ? 440 : theme === 1 ? 417 : 512;
    var left = theme === 2 ? 40 : theme === 1 ? 85 : 10;
    return {
        height: theme === 2 ? 248 : theme === 1 ? 243 : 288,
        left: mirrored ? 1280 - left - width : left,
        top: theme === 2 ? 100 : theme === 1 ? 110 : 62,
        width: width,
    };
}

/**
 * Live `#listIn` content height (padding excluded), or 0 if not laid out.
 * Forces a layout read so Tauri/WKWebView does not report a stale height
 * before caption/footer chrome finishes.
 */
export function listInContentHeight(): number {
    try {
        var box = document.getElementById("listIn");
        if (!box) return 0;
        // Force layout after show()/font apply.
        void (box as HTMLElement).offsetHeight;
        if (box.clientHeight <= 40) return 0;
        var cs = window.getComputedStyle(box);
        var pad =
            (parseFloat(cs.paddingTop) || 0) +
            (parseFloat(cs.paddingBottom) || 0);
        var avail = box.clientHeight - pad;
        return avail > 40 ? avail : 0;
    } catch (_e) {
        return 0;
    }
}

/**
 * Always honor List settings `pageSize` (OTT default 25).
 * Do not shrink pageSize to invent a "fit" cap — keep the cursor on-screen
 * by paging/scrolling like OTT/`setFontSize`, not by reducing row count.
 * Kept as a named helper for call-site compatibility.
 */
export function listFitPageSize(wanted: number): number {
    return Math.max(1, wanted | 0);
}

/**
 * Integer row height so settings.pageSize rows pack into live `#listIn`.
 * Classic companion uses (innerHeight-130*hK)/pageSize as a float; WKWebView
 * then rounds each row up (e.g. 23.6→24) so 25 rows overshoot avail (~590) and
 * only ~21–24 stay visible — worse after window-state restore to non-720 heights.
 * Always return a floored px; when `#listIn` is laid out prefer
 * floor(avail/pageSize) capped by floored classic. Do not shrink pageSize.
 */
export function listRowHeight(pageSize: number): number {
    var ps = Math.max(1, pageSize | 0);
    // Font sizing also runs before the list becomes visible on first open.
    var theme = (window as any).sInterfaceTheme;
    var chrome = theme === 2 ? 180 : theme === 1 ? 210 : 130;
    var classic = Math.max(
        1,
        Math.floor(
            (window.innerHeight - chrome * getViewportHeightScale()) / ps
        )
    );
    var avail = listInContentHeight();
    if (avail > 40) {
        var packed = Math.max(1, Math.floor(avail / ps));
        // Keep companion density upper bound; never taller than avail/pageSize.
        var h = Math.min(classic, packed);
        // Guarantee pageSize * h fits even if avail shrank a px after floor.
        while (h > 1 && h * ps > avail) h--;
        return h;
    }
    return classic;
}

/**
 * After paint: if WKWebView expanded #itN past listRowHeight (flex min-content /
 * subpixel), force exact integer boxes so pageSize rows fit avail. No pageSize change.
 */
export function packListRowBoxes(
    pageStart: number,
    pageEnd: number,
    pageSize: number
): number {
    var ps = Math.max(1, pageSize | 0);
    var avail = listInContentHeight();
    if (!(avail > 40) || pageEnd <= pageStart) return 0;
    var want = Math.max(1, Math.floor(avail / ps));
    while (want > 1 && want * ps > avail) want--;
    var first = document.getElementById("it" + pageStart);
    if (!first) return 0;
    var actual =
        (first as HTMLElement).offsetHeight ||
        first.getBoundingClientRect().height ||
        0;
    var last = document.getElementById("it" + (pageEnd - 1));
    var clipped = false;
    try {
        var box = document.getElementById("listIn");
        if (box && last) {
            var lr = box.getBoundingClientRect();
            var er = last.getBoundingClientRect();
            clipped = er.bottom > lr.bottom + 0.5;
        }
    } catch (_e) {}
    if (
        !clipped &&
        actual > 0 &&
        actual * ps <= avail + 0.5 &&
        actual <= want + 0.5
    ) {
        return want;
    }
    var h = want;
    if (actual > want) h = want;
    // Extra slack if still clipping after one layout with fractional leftovers.
    if (clipped && h * ps > avail - 1) h = Math.max(1, h - 1);
    for (var i = pageStart; i < pageEnd; i++) {
        var el = document.getElementById("it" + i) as HTMLElement | null;
        if (!el) continue;
        el.style.boxSizing = "border-box";
        el.style.margin = "0";
        el.style.paddingTop = "0";
        el.style.paddingBottom = "0";
        el.style.borderTopWidth = "0";
        el.style.borderBottomWidth = "0";
        el.style.height = h + "px";
        el.style.maxHeight = h + "px";
        el.style.minHeight = h + "px";
        el.style.lineHeight = h + "px";
        el.style.overflow = "hidden";
        el.style.flexShrink = "0";
    }
    return h;
}

// Expose globally for UI code that uses window.getViewportWidthScale / window.getViewportHeightScale
if (typeof window !== "undefined") {
    (window as any).getViewportWidthScale = getViewportWidthScale;
    (window as any).getViewportHeightScale = getViewportHeightScale;
    (window as any).listInContentHeight = listInContentHeight;
    (window as any).listFitPageSize = listFitPageSize;
    (window as any).listRowHeight = listRowHeight;
    (window as any).packListRowBoxes = packListRowBoxes;
}

/**
 * Format a number to at least two digits, left-padding with `'0'` if needed.
 *
 * @param num - A non-negative integer (typically 0–59 for minutes/seconds).
 * @returns A two-character string (e.g. `'03'`, `'45'`).
 *
 * @remarks
 * Single-digit inputs become `'0' + digit`; multi-digit inputs are
 * returned as-is via string concatenation.
 */
export function formatTwoDigits(num: number): string {
    return num.toString().length === 1 ? "0" + num : "" + num;
}

/**
 * Convert a Unix timestamp (seconds since epoch) to an `HH:MM` string.
 *
 * @param timestamp - Seconds since 1970-01-01 UTC.
 * @returns A string in the format `"HH:MM"` using local time.
 */
export function time2time(timestamp: number): string {
    var date = new Date(timestamp * 1000);
    return (
        formatTwoDigits(date.getHours()) +
        ":" +
        formatTwoDigits(date.getMinutes())
    );
}

/**
 * Detect the current browser name from the user-agent string.
 *
 * @returns One of `'Firefox'`, `'Opera'`, `'IE'`, `'Edge'`, `'Chrome'`,
 *          `'Safari'`, or `'Unknown'`.
 *
 * @remarks
 * Checks UA substrings in a specific order (Firefox → Opera → Trident →
 * Edge → Chrome → Safari) to avoid false positives (e.g. Chrome also
 * contains "Safari").
 */
export function browserName(): string {
    var ua = navigator.userAgent;
    if (ua.indexOf("Firefox") !== -1) return "Firefox";
    if (ua.indexOf("Opera") !== -1) return "Opera";
    if (ua.indexOf("Trident") !== -1) return "IE";
    if (ua.indexOf("Edge") !== -1) return "Edge";
    if (ua.indexOf("Chrome") !== -1) return "Chrome";
    if (ua.indexOf("Safari") !== -1) return "Safari";
    return "Unknown";
}

/**
 * Show an on-screen alert via the STB `showShift` mechanism.
 *
 * @param msg - The message text to display.
 *
 * @remarks
 * No-ops if `window.showShift` is not present. This is specific to STB
 * middleware that provides `showShift` for on-screen notifications.
 */
export function alert(msg: string): void {
    if (typeof (window as any).showShift === "function")
        (window as any).showShift(msg);
}

/**
 * Write a debug message to a DOM element's innerHTML (prepend).
 *
 * @param elementId - The `id` of the target DOM element.
 * @param text      - The text to log.
 *
 * @sideEffects
 * - Prepends `"<text><br>"` to the element's `innerHTML`.
 * - Falls back to `console.error` if the element is not found.
 */
export function log(elementId: string, text: string): void {
    var el = document.getElementById(elementId);
    if (el !== null) {
        el.innerHTML = text + "<br>" + el.innerHTML;
    } else {
        console.error('log: element "' + elementId + '" is unavailable');
    }
}

/**
 * Dynamically load a JavaScript `<script>` element into a given container.
 *
 * @param url       - The script source URL.
 * @param successCb - Optional callback invoked on successful load.
 * @param errorCb   - Optional callback invoked on load error (receives an Error).
 * @param location  - The DOM element to which the script tag is appended.
 *
 * @sideEffects
 * - Creates and appends a `<script>` element to `location`.
 * - Sets `crossOrigin = 'anonymous'` if the property is supported.
 * - On error: logs to console, calls `alert()`, and invokes `errorCb`.
 */
export function loadScript(
    url: string,
    successCb: (() => void) | null,
    errorCb: ((e: Error) => void) | null,
    location: HTMLElement
): void {
    var standby = (window as any).__ottStandby;
    if (standby && standby.blocked()) {
        if (errorCb) errorCb(standby.error());
        return;
    }
    var release = standby ? standby.track(function () {}) : function () {};
    var script = document.createElement("script");
    script.src = url;
    script.type = "text/javascript";
    if (typeof (script as any).crossOrigin !== "undefined")
        (script as any).crossOrigin = "anonymous";
    script.onload = function () {
        release();
        if (successCb) successCb();
    };
    script.onerror = function () {
        release();
        var err = new Error("Error loading: " + url);
        console.error(err);
        alert(err.message);
        if (typeof errorCb === "function") errorCb(err);
    };
    try {
        location.appendChild(script);
    } catch (error) {
        release();
        throw error;
    }
}

/**
 * Alias for `loadScript` — load a JavaScript file into a given container.
 *
 * @param url       - The script source URL.
 * @param successCb - Optional success callback.
 * @param errorCb   - Optional error callback.
 * @param location  - The DOM element to append the script to.
 *
 * @see loadScript
 */
export function loadJS(
    url: string,
    successCb: (() => void) | null,
    errorCb: ((e: Error) => void) | null,
    location: HTMLElement
): void {
    loadScript(url, successCb, errorCb, location);
}

/**
 * Load a JavaScript file into `document.body`.
 *
 * @param url       - The script source URL.
 * @param successCb - Optional success callback.
 * @param errorCb   - Optional error callback.
 *
 * @remarks
 * Convenience wrapper around `loadScript` that always appends to `<body>`.
 *
 * @see loadScript
 */
export function getScriptDOM(
    url: string,
    successCb: (() => void) | null,
    errorCb: ((e: Error) => void) | null
): void {
    loadScript(url, successCb, errorCb, document.body);
}

/**
 * Dynamic CSS rule manager.
/** Escape external metadata for text or quoted HTML attributes. */
export function metadataText(value: any): string {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
        return {
            "'": "&#39;",
            '"': "&quot;",
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
        }[c]!;
    });
}

/** Image URLs only: metadata must never introduce executable URL schemes. */
export function metadataImageUrl(value: any): string {
    var url = String(value || "").trim();
    if (/[\u0000-\u001f\u007f]/.test(url)) return "";
    if (
        /^[a-z][a-z0-9+.-]*:/i.test(url) &&
        !/^https?:/i.test(url) &&
        !/^data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml);/i.test(url)
    )
        return "";
    return url;
}

export function metadataCssUrl(value: any): string {
    return metadataImageUrl(value).replace(/["'\\()\r\n\f]/g, function (c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

/** Keep basic description formatting, rebuilding it without executable attributes. */
export function metadataHtml(value: any): string {
    var text = String(value == null ? "" : value);
    if (!document.implementation || !document.implementation.createHTMLDocument)
        return metadataText(text);
    var inert = document.implementation.createHTMLDocument("");
    var input = inert.createElement("div");
    input.innerHTML = text;
    var output = inert.createElement("div");
    function copy(from: Node, into: Node): void {
        for (var child = from.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 3)
                into.appendChild(inert.createTextNode(child.nodeValue || ""));
            else if (child.nodeType === 1) {
                var source = child as HTMLElement;
                var tag = source.tagName.toLowerCase();
                if (
                    /^(script|style|iframe|object|embed|svg|math|template|link|meta|base)$/.test(
                        tag
                    )
                )
                    continue;
                if (
                    !/^(b|strong|i|em|u|br|p|div|span|ul|ol|li|table|tbody|tr|td|th|img)$/.test(
                        tag
                    )
                ) {
                    copy(source, into);
                    continue;
                }
                var target = inert.createElement(tag);
                // Preserve the fixed legacy icon class, never metadata-defined classes.
                if (
                    tag === "span" &&
                    source.getAttribute("class") === "fontello"
                )
                    target.setAttribute("class", "fontello");
                if (tag === "img") {
                    var url = metadataImageUrl(source.getAttribute("src"));
                    if (!url) continue;
                    target.setAttribute("src", url);
                    target.setAttribute(
                        "alt",
                        source.getAttribute("alt") || ""
                    );
                }
                copy(source, target);
                into.appendChild(target);
            }
        }
    }
    copy(input, output);
    return output.innerHTML;
}

/** Capacitor has no TMDb companion route; desktop Tauri and server builds do. */
export function hasTmdbService(): boolean {
    return typeof (window as any).Capacitor === "undefined";
}

/**
 * Generate an HTML `<div>` string for a channel thumbnail / preview image.
 *
 * @param url - The thumbnail image URL.
 * @returns An HTML string with inline styles for width, height, margin, and
 *          `background-image`, or an empty string if `window.sThumbnail` is
 *          falsy or `url` is empty.
 *
 * @remarks
 * Width and height are scaled by `getViewportWidthScale()` / `getViewportHeightScale()` relative to
 * the 1280×720 baseline. Base values: width = 133px, height = 200px,
 * margin = width/15. Does NOT insert DOM elements — returns an HTML string
 * for callers to use (e.g. via `innerHTML`).
 */
export function getThumbnail(url: string): string {
    if ((window as any).sThumbnail && url) {
        var w = Math.floor(133 * getViewportWidthScale());
        var h = Math.floor(200 * getViewportHeightScale());
        var m = Math.floor(w / 15);
        return (
            '<div class="img" style="background-image: url(\'' +
            metadataText(metadataCssUrl(url)) +
            "');width:" +
            w +
            "px;height:" +
            h +
            "px;margin:" +
            m +
            'px;float:left;background-size:cover;"></div>'
        );
    }
    return "";
}

/**
 * Log an error message to the browser console.
 *
 * @param msg - The error data to log (passed to `console.log` with an `[ERR]` prefix).
 *
 * @remarks
 * This is a lightweight helper — does not actually POST anywhere despite the
 * name. In the original codebase it may have been intended for server-side
 * error reporting; currently it only logs to console.
 */
export function logPlayerError(msg: any): void {
    if (msg) console.log("[ERR]", msg);
}

/**
 * Compute a simple imul-based hash of a string.
 *
 * @param str - The input string.
 * @returns A 32-bit integer hash value.
 *
 * @remarks
 * Uses `Math.imul` for multiplication (requires the polyfill in older
 * environments). Iterates over each character: `h = imul(h ^ charCode, 387420489)`.
 * Finalises with `h ^ (h >>> 9)`. Not cryptographically secure.
 */
export function hashString32(str: string): number {
    for (var i = 0, h = 9; i < str.length; ) {
        h = Math.imul(h ^ str.charCodeAt(i++), 387420489);
    }
    return h ^ (h >>> 9);
}
