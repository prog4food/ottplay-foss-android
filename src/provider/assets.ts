/** Provider implementations publish factories; only the current owner may mount them. */
var providerAssetGroups: { [kind: string]: string[][] } = {
    // OTTPLAY_FULL_ONLY_BEGIN
    catalog: [["__ottCatalogDrivers", "create", "mountSettings", "reportLoad"]],
    edem: [["__ottEdemDriver", "create", "mount", "reportLoad"]],
    // OTTPLAY_FULL_ONLY_END
    m3u: [
        ["__ottM3uSettings", "mount", "reportLoad"],
        ["__ottM3uDriver", "create", "mount", "reportLoad"],
    ],
    // OTTPLAY_FULL_ONLY_BEGIN
    playlist: [["__ottPlaylistDrivers", "create", "mount", "reportLoad"]],
    // OTTPLAY_FULL_ONLY_END
    plex: [
        ["__ottPlex", "create", "normalize"],
        ["__ottPlexAuth", "start", "connect", "cancel"],
        ["__ottPlexQueueFactory", "create"],
        ["__ottPlexDriver", "create", "mount", "reportLoad"],
    ],
    stalker: [["__ottStalkerDriver", "create", "mountSettings"]],
    vportal: [["__ottVPortalDriver", "create", "mount", "reportLoad"]],
    xtream: [["__ottXtreamMedia", "mount"]],
};

interface ProviderAssetOwner {
    active(): boolean;
    own(cleanup: () => void): () => void;
}
interface ProviderAssetWaiter {
    fail(error: any): void;
    owner: ProviderAssetOwner;
    ready(): void;
    release(): void;
}

type ProviderAssetTransport = (
    url: string,
    ready: () => void,
    fail: (error: any) => void
) => void;

function createProviderAssetLoader(
    host: any,
    transport?: ProviderAssetTransport
) {
    var pending: {
        [kind: string]: { done: boolean; waiters: ProviderAssetWaiter[] };
    } = Object.create(null);

    function load(url: string, ready: () => void, fail: (error: any) => void) {
        var script = host.document.createElement("script");
        script.src = url;
        script.type = "text/javascript";
        function remove() {
            script.onload = script.onerror = null;
            if (script.parentNode) script.parentNode.removeChild(script);
        }
        script.onload = function () {
            remove();
            ready();
        };
        script.onerror = function () {
            remove();
            fail(new Error("Provider module load failed: " + url));
        };
        host.document.body.appendChild(script);
    }

    function initialized(group: string[][]): boolean {
        return group.every(function (entry) {
            var api = host[entry[0]];
            return (
                !!api &&
                entry.slice(1).every(function (method) {
                    return typeof api[method] === "function";
                })
            );
        });
    }

    function ensure(
        kind: string,
        baseUrl: string,
        version: string,
        owner: ProviderAssetOwner,
        ready: () => void,
        fail: (error: any) => void
    ): void {
        if (!owner.active()) return;
        var standby = host.__ottStandby;
        if (standby && standby.blocked()) {
            fail(standby.error());
            return;
        }
        var group = Object.prototype.hasOwnProperty.call(
            providerAssetGroups,
            kind
        )
            ? providerAssetGroups[kind]
            : null;
        // Existing source fixtures and already loaded families stay synchronous.
        if (!group || initialized(group)) {
            ready();
            return;
        }
        var current = pending[kind];
        var start = !current;
        if (!current) {
            current = { done: false, waiters: [] };
            pending[kind] = current;
        }
        var request = current;
        var waiter: ProviderAssetWaiter = {
            fail: fail,
            owner: owner,
            ready: ready,
            release: function () {},
        };
        request.waiters.push(waiter);
        waiter.release = owner.own(function () {
            var index = request.waiters.indexOf(waiter);
            if (index !== -1) request.waiters.splice(index, 1);
        });
        if (!start) return;
        var release = standby ? standby.track(function () {}) : function () {};

        function settle(error?: any): void {
            if (request.done) return;
            release();
            request.done = true;
            delete pending[kind];
            var waiters = request.waiters;
            request.waiters = [];
            var callbackFailed = false;
            var callbackError: any;
            waiters.forEach(function (waiting) {
                waiting.release();
                if (!waiting.owner.active()) return;
                try {
                    if (error) waiting.fail(error);
                    else waiting.ready();
                } catch (caught) {
                    callbackFailed = true;
                    callbackError = caught;
                }
            });
            if (callbackFailed) throw callbackError;
        }
        try {
            (transport || load)(
                baseUrl.replace(/\/$/, "") +
                    "/dist/provider-" +
                    kind +
                    ".js?" +
                    encodeURIComponent(version),
                function () {
                    settle(
                        initialized(group!)
                            ? undefined
                            : new Error("Incomplete provider module: " + kind)
                    );
                },
                function (error: any) {
                    settle(
                        error ||
                            new Error("Provider module load failed: " + kind)
                    );
                }
            );
        } catch (error) {
            // An inline transport may invoke the application callback. Preserve
            // that exception instead of misreporting it as a second load failure.
            if (request.done) throw error;
            settle(error);
        }
    }
    return { ensure: ensure };
}

(window as any).__ottProviderAssets = {
    classic: createProviderAssetLoader(window),
    create: createProviderAssetLoader,
    groups: providerAssetGroups,
};
