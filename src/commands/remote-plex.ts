/** The library resolver shares the queue owner, including lazy loading. */
function validLibraryRequest(params: any, runtime: string): boolean {
    if (!params || params.runtime !== runtime) return false;
    var keys = Object.keys(params).sort().join(",");
    if (params.op === "list") return keys === "op,runtime";
    if (["preview", "play"].indexOf(params.op) < 0) return false;
    var id = typeof params.library_id === "string";
    var expected = id ? "library_id,op,runtime" : "op,query,runtime";
    if (
        (keys !== expected && keys !== expected + ",shuffle") ||
        (params.shuffle !== undefined && typeof params.shuffle !== "boolean")
    )
        return false;
    if (id)
        return (
            /^[1-9][0-9]{0,19}$/.test(params.library_id) &&
            !/\s/.test(params.library_id)
        );
    if (
        typeof params.query !== "string" ||
        !params.query.trim() ||
        /[\u0000-\u001f\u007f]/.test(params.query)
    )
        return false;
    try {
        return (
            encodeURIComponent(params.query).replace(/%[0-9A-F]{2}/g, "x")
                .length <= 256
        );
    } catch (_) {
        return false;
    }
}

/** Keep Plex implementation lazy while capability discovery stays synchronous. */
export function remotePlexQueue(w: any, runtime: string): any {
    if (w.__ottPlexQueue) return w.__ottPlexQueue;
    var controller: any = null;
    var loading: any = null;
    var serial = 0;
    var ids: string[] = [];
    var failure = "";
    var unavailable = "Plex playback is unavailable on this player.";
    var cancelledError = "Plex queue request was cancelled.";
    var capability = {
        max_items: 500,
        operations: ["play", "preview", "status", "next", "previous", "stop"],
        version: 1,
    };
    var libraryCapability = {
        max_items: 500,
        operations: ["list", "preview", "play"],
        version: 1,
    };
    function snapshot(): any {
        if (controller) return controller.snapshot();
        var view: any = {
            active: !!ids.length,
            ids: ids.slice(),
            index: ids.length ? 0 : null,
            order: "listed",
            repeat: "none",
            runtime: runtime,
            state: failure ? "error" : ids.length ? "preparing" : "idle",
            version: 1,
        };
        if (failure) view.error = failure;
        return view;
    }
    function stop(): void {
        var stopping = ++serial;
        if (loading) loading();
        if (stopping !== serial) return;
        ids = [];
        failure = "";
        if (controller) controller.stop();
    }
    function execute(request: any, done: (value: any) => void): any {
        var params = request.params || {};
        var op = params.op;
        var library = request.action === "plex_library";
        var readOnly = op === "preview" || (library && op === "list");
        function reject(error: string): void {
            done({
                data: library
                    ? {
                          error: error,
                          op: op,
                          runtime: runtime,
                          state: "error",
                          version: 1,
                      }
                    : { error: error },
                status: "rejected",
            });
        }
        if (library && !validLibraryRequest(params, runtime)) {
            reject(unavailable);
            return;
        }
        if (controller) return controller.execute(request, done);
        if (
            !library &&
            (params.runtime !== runtime ||
                capability.operations.indexOf(op) < 0 ||
                Object.keys(params).some(function (key) {
                    return (
                        key !== "op" &&
                        key !== "runtime" &&
                        ((op !== "play" && op !== "preview") || key !== "ids")
                    );
                }))
        ) {
            reject(unavailable);
            return;
        }
        if (op === "status") {
            done({ data: snapshot(), status: "ok" });
            return;
        }
        if (op === "stop") {
            stop();
            done({ data: snapshot(), status: "ok" });
            return;
        }
        if (
            !readOnly &&
            typeof w.stbIsStandby === "function" &&
            w.stbIsStandby()
        ) {
            reject("Wake the player before starting Plex playback.");
            return;
        }
        if (!readOnly && w.commandChannelsReady !== true) {
            reject(unavailable);
            return;
        }
        if (
            !library &&
            (!Array.isArray(params.ids) ||
                !params.ids.length ||
                params.ids.length > 500 ||
                params.ids.some(function (id: any) {
                    return (
                        typeof id !== "string" || !/^[1-9][0-9]{0,19}$/.test(id)
                    );
                }))
        ) {
            reject("Plex queue is empty.");
            return;
        }
        if (loading && (readOnly || op !== "play")) {
            reject("Plex queue request is already in progress.");
            return;
        }
        var intent = ++serial;
        if (loading) loading();
        if (intent !== serial) {
            reject(cancelledError);
            return;
        }
        if (op === "play") {
            ids = library ? [] : params.ids.slice();
            failure = "";
        }
        var cancelled = false;
        var cancelInner: any = null;
        var cleanups: Array<() => void> = [];
        var provider = w.__ottActiveProviderDriver;
        var config = w.stbGetItem("plexcfg");
        var playback = w.__ottClassicPlayback;
        var generation = playback && playback.snapshot().generation;
        var timer: any;
        function cancel(): void {
            if (cancelled) return;
            cancelled = true;
            if (!controller && op === "play") {
                if (!failure) failure = cancelledError;
                ids = [];
            }
            if (loading === cancel) loading = null;
            w.clearTimeout(timer);
            cleanups.forEach(function (fn) {
                fn();
            });
            if (cancelInner) cancelInner();
        }
        function failed(): void {
            if (cancelled) return;
            var error = "Plex provider module could not be loaded.";
            if (op === "play") failure = error;
            cancel();
            reject(error);
        }
        loading = cancel;
        timer = w.setTimeout(failed, 35000);
        function ready(): void {
            if (cancelled || intent !== serial) return;
            if (
                provider !== w.__ottActiveProviderDriver ||
                config !== w.stbGetItem("plexcfg") ||
                (!readOnly &&
                    typeof w.stbIsStandby === "function" &&
                    w.stbIsStandby()) ||
                (playback && playback.snapshot().generation !== generation) ||
                (typeof request.expires_at === "number" &&
                    Date.now() >= request.expires_at * 1000)
            ) {
                failed();
                return;
            }
            w.clearTimeout(timer);
            loading = null;
            controller = w.__ottPlexQueueFactory.create(
                w,
                runtime,
                failure,
                validLibraryRequest
            );
            cancelInner = controller.execute(request, done);
        }
        try {
            if (w.__ottPlexQueueFactory) ready();
            else
                w.__ottProviderAssets.classic.ensure(
                    "plex",
                    w.host || "",
                    w.__cv || "",
                    {
                        active: function () {
                            return !cancelled;
                        },
                        own: function (fn: () => void) {
                            cleanups.push(fn);
                            return function () {
                                var at = cleanups.indexOf(fn);
                                if (at >= 0) cleanups.splice(at, 1);
                            };
                        },
                    },
                    ready,
                    failed
                );
        } catch (_) {
            failed();
        }
        return cancel;
    }
    var api = {
        capability: capability,
        execute: execute,
        libraryCapability: libraryCapability,
        retained: function () {
            return controller
                ? controller.retained()
                : !!loading && !!ids.length;
        },
        snapshot: snapshot,
        stop: stop,
    };
    w.__ottPlexQueue = api;
    if (w.addEventListener)
        w.addEventListener("pagehide", function () {
            if (loading) loading();
        });
    return api;
}
