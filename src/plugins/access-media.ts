/** iOS owns source credentials and returns only a per-launch loopback media URL. */
export function accessMediaPlugin(): any {
    var cap = (window as any).Capacitor;
    return cap &&
        typeof cap.getPlatform === "function" &&
        cap.getPlatform() === "ios" &&
        cap.Plugins
        ? cap.Plugins.AccessMedia
        : undefined;
}

var accessMediaRequestSequence = 0;

export function prepareAccessMedia(
    url: string,
    ready: (url: string) => void,
    failed: () => void
): (() => void) | undefined {
    var plugin = accessMediaPlugin();
    if (!plugin || !/^https:\/\//i.test(url)) {
        ready(url);
        return;
    }
    var requestId = Date.now() + "-" + ++accessMediaRequestSequence;
    var active = true;
    function reject(): void {
        if (!active) return;
        active = false;
        failed();
    }
    plugin.prepare({ requestId: requestId, url: url }).then(function (result: {
        url: string;
    }) {
        if (!active) return;
        if (!result || typeof result.url !== "string") {
            reject();
            return;
        }
        // Do not turn a native bridge error into navigation to another origin.
        if (
            result.url !== url &&
            !/^http:\/\/127\.0\.0\.1:\d+\/access\/[A-Za-z0-9_-]{43}\//.test(
                result.url
            )
        ) {
            reject();
            return;
        }
        active = false;
        ready(result.url);
    }, reject);
    return function () {
        if (!active) return;
        active = false;
        try {
            plugin
                .cancelPrepare({ requestId: requestId })
                .catch(function () {});
        } catch (_error) {}
    };
}
