/** Recognize explicit HTTP HLS sources without changing a portal's signed URL. */
export function isNativeHlsUrl(url: string): boolean {
    return /^https?:\/\/[^\s?#]+(?:\.m3u8(?:[?#]|$)|\?(?:[^\s#]*&)?extension=m3u8(?:[&#]|$))/i.test(
        url
    );
}

/** Native HLS keeps the platform decoder; Rust measures the media it requests. */
export function createNativeHlsTransport(
    url: string,
    options: {
        active: () => boolean;
        ready: (url: string) => void;
        failed: () => void;
        changed: () => void;
    }
): { cancel: () => void; poll: () => void; mbps: () => number } | null {
    // MAG gateways advertise HLS in the query instead of the PHP path. Keep
    // their signed URL intact and let Rust load the media for the WebView.
    if (!isNativeHlsUrl(url)) return null;
    var host = window as any;
    var bridge =
        (host.__TAURI__ && host.__TAURI__.core) || host.__TAURI_INTERNALS__;
    if (!bridge || typeof bridge.invoke !== "function") return null;

    var disposed = false;
    var session: string | null = null;
    var bitrate = 0;
    var pending = false;
    var lastPoll = -Infinity;

    function stop(token: string): void {
        try {
            bridge.invoke("native_hls_stop", { session: token }).then(
                function () {},
                function () {}
            );
        } catch (_stopError) {}
    }

    function cancel(): void {
        if (disposed) return;
        disposed = true;
        bitrate = 0;
        if (session) stop(session);
        session = null;
    }

    function current(): boolean {
        if (!disposed && options.active()) return true;
        cancel();
        return false;
    }

    function failed(): void {
        if (!current()) return;
        cancel();
        options.failed();
    }

    try {
        bridge.invoke("native_hls_start", { url: url }).then(function (
            result: any
        ) {
            // A channel change/stop may finish before native session creation.
            if (!current()) {
                if (result && typeof result.session === "string")
                    stop(result.session);
                return;
            }
            if (
                !result ||
                typeof result.session !== "string" ||
                !result.session ||
                typeof result.url !== "string" ||
                !/^http:\/\/127\.0\.0\.1:\d+\//.test(result.url)
            ) {
                if (result && typeof result.session === "string")
                    stop(result.session);
                failed();
                return;
            }
            session = result.session;
            options.ready(result.url);
        }, failed);
    } catch (_startError) {
        failed();
    }

    return {
        cancel: cancel,
        mbps: function (): number {
            return disposed ? 0 : bitrate;
        },
        poll: function (): void {
            if (!current() || !session || pending) return;
            var now = Date.now();
            if (now - lastPoll < 1000) return;
            lastPoll = now;
            pending = true;
            function unavailable(): void {
                pending = false;
            }
            try {
                bridge
                    .invoke("native_hls_stats", { session: session })
                    .then(function (stats: any) {
                        pending = false;
                        if (!current()) return;
                        var next = 0;
                        if (
                            stats &&
                            typeof stats.bytes === "number" &&
                            stats.bytes > 0 &&
                            isFinite(stats.bytes) &&
                            typeof stats.seconds === "number" &&
                            stats.seconds > 0 &&
                            isFinite(stats.seconds) &&
                            stats.samples > 0 &&
                            stats.samples <= 8
                        )
                            next = (stats.bytes * 8) / stats.seconds / 1e6;
                        if (!isFinite(next)) next = 0;
                        if (next !== bitrate) {
                            bitrate = next;
                            options.changed();
                        }
                    }, unavailable);
            } catch (_statsError) {
                unavailable();
            }
        },
    };
}
