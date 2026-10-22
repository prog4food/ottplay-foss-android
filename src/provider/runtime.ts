/**
 * Session ownership, independent of catalog formats and playback policy.
 * This private module publishes one boundary for the transitional classic host.
 */
interface ProviderSession {
    active(): boolean;
    dispose(): void;
    readonly generation: number;
    guard(callback: (...args: any[]) => any): (...args: any[]) => any;
    readonly id: string;
    own(dispose: () => void): () => void;
}

function createProviderRegistry() {
    var generation = 0;
    var current: ProviderSession | null = null;
    function activate(id: string): ProviderSession {
        // Invalidate before cleanup: abort can synchronously invoke callbacks.
        var previous = current;
        var disposed = false;
        var cleanups: Array<() => void> = [];
        var session: ProviderSession = {
            active: function () {
                return !disposed && current === session;
            },
            dispose: function () {
                if (disposed) return;
                disposed = true;
                var pending = cleanups;
                cleanups = [];
                for (var i = pending.length - 1; i >= 0; i--) {
                    try {
                        pending[i]();
                    } catch (_) {
                        // A failed transport teardown must not keep others alive.
                    }
                }
            },
            generation: ++generation,
            guard: function (callback) {
                return function (this: any) {
                    if (session.active())
                        return callback.apply(this, arguments);
                };
            },
            id: id,
            own: function (cleanup) {
                if (!session.active()) {
                    try {
                        cleanup();
                    } catch (_) {
                        // Late ownership is teardown too; an already retired
                        // request must not interrupt a newer provider's work.
                    }
                    return function () {};
                }
                cleanups.push(cleanup);
                return function () {
                    var index = cleanups.indexOf(cleanup);
                    if (index !== -1) cleanups.splice(index, 1);
                };
            },
        };
        current = session;
        if (previous) previous.dispose();
        return session;
    }
    return {
        activate: activate,
        current: function () {
            return current && current.active() ? current : null;
        },
        dispose: function () {
            var previous = current;
            current = null;
            if (previous) previous.dispose();
        },
    };
}

/**
 * Own provider/catalog lifetimes and serialize replacement during startup.
 * Full dealer extensions retain scoped transport/timers and script evaluation;
 * that compatibility machinery is omitted from Play, whose providers all use
 * registered drivers with explicit request ownership. Managed drivers in Full
 * also bypass interception.
 */
function createClassicProviderAdapter(host: any) {
    var providers = createProviderRegistry();
    var catalogs = createProviderRegistry();
    var loadingScript = false;
    var replacementGeneration = 0;
    var desired: {
        session: ProviderSession;
        start: (s: ProviderSession) => void;
        unscoped: boolean;
    } | null = null;
    var draining = false;

    // OTTPLAY_FULL_ONLY_BEGIN
    function scopedCallback(session: ProviderSession, callback: any): any {
        if (Array.isArray(callback)) {
            return callback.map(function (item) {
                return scopedCallback(session, item);
            });
        }
        if (typeof callback !== "function") return callback;
        return function (this: any) {
            var receiver = this;
            var args = arguments;
            return run(session, function () {
                return callback.apply(receiver, args);
            });
        };
    }

    function scopeDeferred(session: ProviderSession, request: any): any {
        if (!request || request.__ottProviderOwner === session) return request;
        // Real jqXHR remains the return value: identity, abort and context survive.
        request.__ottProviderOwner = session;
        ["done", "fail", "always", "then", "pipe", "progress"].forEach(
            function (name) {
                var original = request[name];
                if (typeof original !== "function") return;
                request[name] = function (this: any) {
                    var callbacks: any[] = [];
                    for (var i = 0; i < arguments.length; i++)
                        callbacks.push(scopedCallback(session, arguments[i]));
                    var next = original.apply(this, callbacks);
                    return next === request
                        ? request
                        : scopeDeferred(session, next);
                };
            }
        );
        return request;
    }

    function run(session: ProviderSession, action: () => any): any {
        if (!session.active()) return;
        var jquery = host.$;
        var previousAjax = jquery && jquery.ajax;
        var ajax =
            (previousAjax && previousAjax.__ottProviderAjaxBase) ||
            previousAjax;
        var timerNames = ["setTimeout", "setInterval"];
        var savedTimers: any[] = [];
        var scopedTimers: any[] = [];
        var scopedAjax: any;
        if (typeof ajax === "function") {
            scopedAjax = function (
                this: any,
                urlOrOptions: any,
                options?: any
            ) {
                var settings =
                    typeof urlOrOptions === "string"
                        ? options || {}
                        : urlOrOptions || {};
                var guarded: any = {};
                var key: string;
                for (key in settings) {
                    if (Object.prototype.hasOwnProperty.call(settings, key))
                        guarded[key] = settings[key];
                }
                ["success", "error", "beforeSend", "dataFilter"].forEach(
                    function (name) {
                        guarded[name] = scopedCallback(session, settings[name]);
                    }
                );
                if (settings.statusCode) {
                    guarded.statusCode = {};
                    for (key in settings.statusCode)
                        guarded.statusCode[key] = scopedCallback(
                            session,
                            settings.statusCode[key]
                        );
                }
                var settled = false;
                var release = function () {};
                var complete = scopedCallback(session, settings.complete);
                guarded.complete = function (this: any) {
                    settled = true;
                    release();
                    var receiver = this;
                    var args = arguments;
                    function invoke(callback: any): void {
                        if (Array.isArray(callback)) callback.forEach(invoke);
                        else if (typeof callback === "function")
                            callback.apply(receiver, args);
                    }
                    invoke(complete);
                };
                var request =
                    typeof urlOrOptions === "string"
                        ? ajax.call(this, urlOrOptions, guarded)
                        : ajax.call(this, guarded);
                if (
                    !settled &&
                    request &&
                    typeof request.abort === "function"
                ) {
                    release = session.own(function () {
                        request.abort();
                    });
                    if (typeof request.always === "function")
                        request.always(function () {
                            settled = true;
                            release();
                        });
                }
                return scopeDeferred(session, request);
            };
            scopedAjax.__ottProviderAjaxBase = ajax;
            jquery.ajax = scopedAjax;
        }
        timerNames.forEach(function (name, index) {
            var previous = host[name];
            var original =
                (previous && previous.__ottProviderTimerBase) || previous;
            savedTimers[index] = previous;
            if (typeof original !== "function") return;
            var clear = host[index ? "clearInterval" : "clearTimeout"];
            scopedTimers[index] = function (callback: any, delay: any) {
                // String timers are not introduced by the provider contract.
                if (typeof callback !== "function")
                    return original.apply(host, arguments);
                var args: any[] = [];
                for (var i = 2; i < arguments.length; i++)
                    args.push(arguments[i]);
                var release = function () {};
                var timer = original.call(
                    host,
                    function () {
                        if (!index) release();
                        run(session, function () {
                            callback.apply(host, args);
                        });
                    },
                    delay
                );
                release = session.own(function () {
                    if (typeof clear === "function") clear.call(host, timer);
                });
                return timer;
            };
            scopedTimers[index].__ottProviderTimerBase = original;
            host[name] = scopedTimers[index];
        });
        try {
            return action();
        } finally {
            // Preserve an intentional transport replacement by a native bridge.
            if (jquery && jquery.ajax === scopedAjax)
                jquery.ajax = previousAjax;
            timerNames.forEach(function (name, index) {
                if (host[name] === scopedTimers[index])
                    host[name] = savedTimers[index];
            });
        }
    }

    // OTTPLAY_FULL_ONLY_END

    function drain(): void {
        if (loadingScript || draining) return;
        draining = true;
        var failed = false;
        var firstError: any;
        try {
            while (!loadingScript && desired) {
                var pending = desired;
                desired = null;
                try {
                    // OTTPLAY_FULL_ONLY_BEGIN
                    if (!pending.unscoped) {
                        run(pending.session, function () {
                            pending.start(pending.session);
                        });
                        continue;
                    }
                    // OTTPLAY_FULL_ONLY_END
                    if (pending.session.active())
                        pending.start(pending.session);
                } catch (error) {
                    if (!failed) firstError = error;
                    failed = true;
                }
            }
        } finally {
            draining = false;
        }
        if (failed) throw firstError;
    }

    return {
        beginCatalog: function (unscoped?: boolean) {
            var session = catalogs.activate("catalog");
            return {
                active: session.active,
                dispose: session.dispose,
                guard: function (callback: any) {
                    // OTTPLAY_FULL_ONLY_BEGIN
                    if (!unscoped) return scopedCallback(session, callback);
                    // OTTPLAY_FULL_ONLY_END
                    return session.guard(callback);
                },
                own: session.own,
                run: function (callback: () => any) {
                    // OTTPLAY_FULL_ONLY_BEGIN
                    if (!unscoped) return run(session, callback);
                    // OTTPLAY_FULL_ONLY_END
                    if (session.active()) return callback();
                },
            };
        },
        // OTTPLAY_FULL_ONLY_BEGIN
        bind: function (session: ProviderSession, names: string[]) {
            names.forEach(function (name) {
                if (typeof host[name] === "function")
                    host[name] = scopedCallback(session, host[name]);
            });
        },
        // OTTPLAY_FULL_ONLY_END
        dispose: function () {
            replacementGeneration++;
            desired = null;
            catalogs.dispose();
            providers.dispose();
        },
        // OTTPLAY_FULL_ONLY_BEGIN
        loadScript: function (
            session: ProviderSession,
            loader: (
                url: string,
                success: () => void,
                failure: (error: any) => void
            ) => void,
            url: string,
            success: () => void,
            failure: (error: any) => void
        ) {
            if (!session.active()) return;
            loadingScript = true;
            var settled = false;
            function finish(callback: () => void): void {
                if (settled) return;
                settled = true;
                loadingScript = false;
                try {
                    run(session, callback);
                } finally {
                    drain();
                }
            }
            try {
                loader(
                    url,
                    function () {
                        finish(success);
                    },
                    function (error) {
                        finish(function () {
                            failure(error);
                        });
                    }
                );
            } catch (error) {
                // A synchronous test/native loader may call success inline.
                // Errors in that callback are application errors, not a second
                // script failure, and must not disappear behind settled=true.
                if (settled) throw error;
                finish(function () {
                    failure(error);
                });
            }
        },
        // OTTPLAY_FULL_ONLY_END
        replace: function (
            start: (session: ProviderSession) => void,
            unscoped?: boolean
        ) {
            // Disposal precedes resetting shared classic data, including catalog timers.
            var replacement = ++replacementGeneration;
            catalogs.dispose();
            if (replacement !== replacementGeneration)
                return providers.current();
            var session = providers.activate("classic");
            // A cleanup may synchronously request another source. That newer
            // selection already owns the registry and must keep its queued start.
            if (!session.active()) return session;
            desired = { session: session, start: start, unscoped: !!unscoped };
            drain();
            return session;
        },
    };
}

if (typeof window !== "undefined") {
    (window as any).__ottProviderRuntime = {
        classic: createClassicProviderAdapter(window),
        createClassicAdapter: createClassicProviderAdapter,
        createRegistry: createProviderRegistry,
        suspend: function () {
            (window as any).__ottProviderRuntime.classic.dispose();
        },
    };
}
