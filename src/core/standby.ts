/** Device-local work admission. Remote transports explicitly retain connectivity. */
export function installStandby(w: any, read: any, write: any): any {
    if (w.__ottStandby) return w.__ottStandby;
    var asleep = false;
    try {
        asleep = read("__ottStandbyV1") === "1";
    } catch (_) {}
    var epoch = 0;
    var waking = false;
    var probing = false;
    var boot: Promise<any> = Promise.resolve();
    var retireProbe = function () {};
    var applied = false;
    var nativeState = "running";
    var nativePending: number | null = 0;
    var nativeSet: any = null;
    var nativeStatus: any = null;
    var nativeTimer: any = null;
    var nativeQueue: Promise<any> = Promise.resolve();
    var jobs: Array<() => void> = [];
    var cleanupFailed = false;
    var unverified = false;
    function blocked(): boolean {
        return asleep || waking || probing;
    }
    function error(): Error {
        return new Error("Player is in standby; use go to resume");
    }
    function track(cancel: () => void): () => void {
        if (blocked()) throw error();
        jobs.push(cancel);
        return function () {
            var i = jobs.indexOf(cancel);
            if (i !== -1) jobs.splice(i, 1);
        };
    }
    function observe<T>(
        pending: PromiseLike<T>,
        cleanup?: boolean
    ): PromiseLike<T> {
        // Existing native/decoder/file work may settle after admission closes.
        var job = function () {};
        jobs.push(job);
        function release(): void {
            var i = jobs.indexOf(job);
            if (i !== -1) jobs.splice(i, 1);
        }
        Promise.resolve(pending).then(release, function () {
            release();
            if (cleanup) cleanupFailed = true;
        });
        return pending;
    }
    function attempt(effect: () => void): void {
        try {
            effect();
        } catch (_) {
            cleanupFailed = true;
        }
    }
    function invoke(name: string, method: string): void {
        var owner = w[name];
        if (owner && typeof owner[method] === "function")
            attempt(function () {
                owner[method]();
            });
    }
    function suspend(): void {
        // Invalidate owners before abort: transports may synchronously call back.
        var timers = w.__ottUiTimers;
        if (timers) {
            w.clearInterval(timers.clock);
            w.clearInterval(timers.guide);
        }
        w.__ottUiTimers = null;
        invoke("__ottProviderRuntime", "suspend");
        invoke("__ottActiveProviderDriver", "dispose");
        w.__ottActiveProviderDriver = null;
        w.__ottCommandChannelLoad = {};
        w.commandChannelsReady = false;
        invoke("providerMediaClient", "dispose");
        invoke("__ottMedia", "cancelLoad");
        invoke("__ottMedia", "cancelRequest");
        invoke("__ottMedia", "cancelAuto");
        invoke("__ottLocalMedia", "suspend");
        invoke("__ottBrowserLocalMedia", "suspend");
        invoke("__ottClassicGuide", "suspend");
        invoke("__ottHostedEpg", "suspend");
        invoke("__ottClassicReminders", "dispose");
        var pending = jobs.slice();
        pending.forEach(function (cancel) {
            attempt(cancel);
        });
    }
    function nativeResult(value: any): void {
        if (
            !value ||
            value.standby !== asleep ||
            typeof value.pending !== "number" ||
            !isFinite(value.pending) ||
            value.pending < 0 ||
            Math.floor(value.pending) !== value.pending ||
            typeof value.quiescent !== "boolean"
        )
            throw new Error("Invalid native standby acknowledgement");
        nativePending = Math.min(2147483647, value.pending);
        nativeState =
            value.quiescent && value.pending === 0 ? "suspended" : "suspending";
    }
    function syncNative(ready?: () => void): void {
        var expected = epoch;
        var requested = asleep;
        var effect = nativeSet;
        w.clearTimeout(nativeTimer);
        if (!effect) {
            if (ready) ready();
            return;
        }
        nativeState = "suspending";
        nativePending = null;
        var settled = false;
        var deadline: any;
        function failed(reason: any): void {
            if (settled) return;
            settled = true;
            w.clearTimeout(deadline);
            if (epoch !== expected) return;
            nativeState =
                reason &&
                /not implemented|not found|unavailable|unsupported/i.test(
                    String(reason.message || reason)
                )
                    ? "unsupported"
                    : "error";
            nativePending = null;
            // Older shells can still be explicitly woken. Other failures keep
            // playback blocked and restore sleep after any late native wake.
            if (ready && nativeState === "unsupported") ready();
            else if (ready) {
                asleep = true;
                waking = false;
                attempt(function () {
                    write("__ottStandbyV1", "1");
                });
                epoch++;
                syncNative();
                nativeState = "error";
            }
        }
        function observe(value: any): void {
            if (settled || epoch !== expected) return;
            try {
                nativeResult(value);
            } catch (reason) {
                failed(reason);
                return;
            }
            if (!ready) w.clearTimeout(deadline);
            if (nativePending === 0 && (ready || nativeState === "suspended")) {
                settled = true;
                w.clearTimeout(deadline);
                if (ready) ready();
                return;
            }
            if (nativeStatus)
                nativeTimer = w.setTimeout(function () {
                    if (settled || epoch !== expected) return;
                    Promise.resolve().then(nativeStatus).then(observe, failed);
                }, 250);
        }
        // Wake has one bounded deadline, including old native cleanup. A
        // sleep ACK may keep reporting pending work until it actually drains.
        deadline = w.setTimeout(function () {
            failed(new Error("Native standby acknowledgement timed out"));
        }, 10000);
        // Timeouts abandon this waiter, never the ordered native operation.
        nativeQueue = nativeQueue
            .catch(function () {})
            .then(function () {
                return effect(requested);
            });
        nativeQueue.then(observe, failed);
    }
    var api = {
        blocked: blocked,
        current: function (generation: number) {
            return !blocked() && generation === epoch;
        },
        error: error,
        failed: function () {
            cleanupFailed = true;
        },
        generation: function () {
            return epoch;
        },
        isStandby: function () {
            return blocked();
        },
        localKey: function (event?: any): boolean {
            if (event && /^key/.test(event.type)) {
                var consumed = blocked() || wakeKey;
                if (consumed) localInput(event);
                return consumed;
            }
            // Older native shells call _doKey without DOM events or key-up.
            if (!blocked()) return false;
            wakeFromInput();
            return true;
        },
        native: function (set: any, status: any) {
            nativeSet = set;
            nativeStatus = status;
            if (blocked()) syncNative();
            else if (nativeStatus) {
                var expected = epoch;
                probing = true;
                nativeState = "suspending";
                nativePending = null;
                boot = new Promise(function (resolve) {
                    var settled = false;
                    var timer = w.setTimeout(function () {
                        finish(
                            null,
                            new Error("Native standby probe timed out")
                        );
                    }, 10000);
                    function finish(
                        value: any,
                        failure?: any,
                        retired?: boolean
                    ): void {
                        if (settled) return;
                        settled = true;
                        w.clearTimeout(timer);
                        probing = false;
                        if (!retired && expected === epoch) {
                            var unsupported =
                                failure &&
                                /not implemented|not found|unavailable|unsupported/i.test(
                                    String(failure.message || failure)
                                );
                            if (
                                !failure &&
                                (!value ||
                                    typeof value.standby !== "boolean" ||
                                    typeof value.pending !== "number" ||
                                    !isFinite(value.pending) ||
                                    value.pending < 0 ||
                                    Math.floor(value.pending) !==
                                        value.pending ||
                                    typeof value.quiescent !== "boolean")
                            )
                                failure = new Error(
                                    "Invalid native standby status"
                                );
                            if (unsupported) {
                                nativeState = "unsupported";
                            } else if (failure || value.standby) {
                                api.set(true);
                                if (failure) nativeState = "error";
                                if (typeof w.stbSetStandby === "function")
                                    w.stbSetStandby(true);
                            } else {
                                nativeState = "running";
                                nativePending = value.pending;
                            }
                        }
                        resolve(null);
                    }
                    retireProbe = function () {
                        finish(null, null, true);
                    };
                    Promise.resolve()
                        .then(nativeStatus)
                        .then(
                            function (value) {
                                finish(value);
                            },
                            function (failure) {
                                finish(null, failure);
                            }
                        );
                });
            }
        },
        observe: observe,
        ready: function (effect: () => void) {
            var expected = epoch;
            if (probing)
                void boot.then(function () {
                    if (expected === epoch) effect();
                });
            else effect();
        },
        set: function (value: boolean, resume?: () => void) {
            if (value) {
                if (asleep && applied && !waking) {
                    if (
                        nativeState === "error" ||
                        nativeState === "unsupported"
                    )
                        syncNative();
                    return;
                }
                applied = true;
                cleanupFailed = false;
                if (!asleep || waking) {
                    // Save the last confirmed cursor before retiring its source owner.
                    attempt(function () {
                        var playback = w.__ottClassicPlayback;
                        var backend =
                            w.__ottCoreBackendPeek && w.__ottCoreBackendPeek();
                        var handle = backend && backend.current();
                        if (handle && handle.active()) handle.sample();
                        if (playback && playback.checkpoint)
                            playback.checkpoint(playback.snapshot(), true);
                    });
                    epoch++;
                }
                asleep = true;
                waking = false;
                retireProbe();
                attempt(function () {
                    write("__ottStandbyV1", "1");
                });
                suspend();
                syncNative();
            } else {
                if ((!asleep && !probing) || waking) return;
                epoch++;
                asleep = false;
                waking = true;
                retireProbe();
                unverified = false;
                syncNative(function () {
                    waking = false;
                    attempt(function () {
                        write("__ottStandbyV1", "0");
                    });
                    if (resume) resume();
                });
            }
        },
        snapshot: function () {
            var count =
                nativePending === null
                    ? null
                    : Math.min(2147483647, jobs.length + nativePending);
            return {
                pending: count,
                state: !blocked()
                    ? "running"
                    : cleanupFailed
                      ? "error"
                      : unverified
                        ? "unsupported"
                        : nativeState === "error" ||
                            nativeState === "unsupported"
                          ? nativeState
                          : count === 0 &&
                              !waking &&
                              nativeState !== "suspending"
                            ? "suspended"
                            : "suspending",
            };
        },
        track: track,
    };
    w.__ottStandby = api;
    // Capture before player/kiosk handlers. Waking is always allowed, but the
    // gesture that wakes must not also navigate, change volume or unlock UI.
    var wakeKey = false;
    var wakePointer = false;
    var wakeMouseReleased = false;
    function consumeInput(event: any): void {
        if (event.preventDefault) event.preventDefault();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
        else if (event.stopPropagation) event.stopPropagation();
    }
    function wakeFromInput(): void {
        if (asleep && typeof w.stbSetStandby === "function")
            w.stbSetStandby(false);
    }
    function localInput(event: any): void {
        var type = event.type;
        if (/^key/.test(type)) {
            if (!blocked() && !wakeKey) return;
            if (type === "keyup") {
                consumeInput(event);
                wakeKey = false;
                return;
            }
            if (!wakeKey && event.repeat) {
                consumeInput(event);
                return;
            }
            var firstKey = !wakeKey;
            wakeKey = true;
            consumeInput(event);
            if (firstKey) wakeFromInput();
            return;
        }
        if (type === "pointerdown") {
            // A new physical gesture ends suppression of an older touch which
            // produced no compatibility click after preventDefault().
            wakePointer = blocked();
            wakeMouseReleased = false;
            if (!wakePointer) return;
        } else if (type === "touchstart") {
            if (!w.PointerEvent) {
                wakePointer = blocked();
                wakeMouseReleased = false;
            }
            if (!wakePointer && !blocked()) return;
            wakePointer = true;
        } else if (type === "mousedown") {
            if (!blocked() && wakeMouseReleased) wakePointer = false;
            wakeMouseReleased = false;
            if (!wakePointer && !blocked()) return;
            wakePointer = true;
        } else if (!wakePointer && !blocked()) return;
        consumeInput(event);
        if (type === "mouseup") wakeMouseReleased = true;
        if (
            type === "pointerdown" ||
            type === "mousedown" ||
            type === "touchstart" ||
            type === "click"
        )
            wakeFromInput();
        if (
            type === "click" ||
            type === "pointercancel" ||
            type === "touchcancel"
        )
            wakePointer = false;
    }
    if (typeof w.addEventListener === "function")
        [
            "keydown",
            "keypress",
            "keyup",
            "pointerdown",
            "pointerup",
            "pointercancel",
            "mousedown",
            "mouseup",
            "touchstart",
            "touchend",
            "touchcancel",
            "click",
            "contextmenu",
        ].forEach(function (type) {
            w.addEventListener(type, localInput, {
                capture: true,
                passive: false,
            });
        });
    // Preserve the actual Request/Response contracts; only work ownership changes.
    if (typeof w.fetch === "function") {
        var fetch = w.fetch;
        w.fetch = function (input: any, options?: any) {
            if (
                (input && input.__ottRemoteControl) ||
                (options && options.__ottRemoteControl)
            )
                return fetch.call(w, input, options);
            if (blocked()) return Promise.reject(error());
            var abortable = typeof w.AbortController === "function";
            var controller = abortable
                ? new w.AbortController()
                : {
                      abort: function () {
                          this.signal.aborted = true;
                      },
                      signal: { aborted: false },
                  };
            var signal = (options && options.signal) || (input && input.signal);
            var release = function () {};
            function cancel(): void {
                controller.abort();
                if (abortable) finish();
                else unverified = true;
            }
            release = track(cancel);
            if (signal) {
                if (signal.aborted) controller.abort();
                else signal.addEventListener("abort", cancel, { once: true });
            }
            function finish(): void {
                release();
                if (signal) signal.removeEventListener("abort", cancel);
            }
            var settings = abortable
                ? Object.assign({}, options || {}, {
                      signal: controller.signal,
                  })
                : options;
            var pending: any;
            try {
                pending = fetch.call(w, input, settings);
            } catch (reason) {
                finish();
                return Promise.reject(reason);
            }
            return pending.then(
                function (response: any) {
                    if (controller.signal.aborted) {
                        finish();
                        throw error();
                    }
                    if (!response.body && response.status === 204) finish();
                    ["arrayBuffer", "blob", "formData", "json", "text"].forEach(
                        function (name) {
                            var consume = response[name];
                            if (typeof consume !== "function") return;
                            response[name] = function () {
                                return consume.apply(response, arguments).then(
                                    function (value: any) {
                                        finish();
                                        if (controller.signal.aborted)
                                            throw error();
                                        return value;
                                    },
                                    function (reason: any) {
                                        finish();
                                        throw reason;
                                    }
                                );
                            };
                        }
                    );
                    var body = response.body;
                    if (body && typeof body.getReader === "function") {
                        var getReader = body.getReader;
                        body.getReader = function () {
                            var reader = getReader.apply(body, arguments);
                            var read = reader.read;
                            reader.read = function () {
                                return read.apply(reader, arguments).then(
                                    function (part: any) {
                                        if (part.done) finish();
                                        if (controller.signal.aborted)
                                            throw error();
                                        return part;
                                    },
                                    function (reason: any) {
                                        finish();
                                        throw reason;
                                    }
                                );
                            };
                            var cancelReader = reader.cancel;
                            reader.cancel = function () {
                                finish();
                                return cancelReader.apply(reader, arguments);
                            };
                            return reader;
                        };
                    }
                    return response;
                },
                function (reason: any) {
                    finish();
                    throw reason;
                }
            );
        };
    }
    var prototype = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (prototype && typeof prototype.send === "function") {
        var send = prototype.send;
        prototype.send = function () {
            var xhr = this;
            if (xhr.__ottRemoteControl) return send.apply(xhr, arguments);
            if (blocked()) throw error();
            var release = track(function () {
                xhr.abort();
                release();
            });
            xhr.addEventListener("loadend", release, { once: true });
            try {
                return send.apply(xhr, arguments);
            } catch (reason) {
                release();
                throw reason;
            }
        };
    }
    // Covers native jQuery transports and script/JSONP requests as well as XHR.
    if (w.$ && typeof w.$.ajaxPrefilter === "function")
        w.$.ajaxPrefilter(function (_settings: any, _original: any, xhr: any) {
            if (blocked()) {
                xhr.abort("standby");
                return;
            }
            var release = track(function () {
                xhr.abort("standby");
            });
            xhr.always(release);
        });
    return api;
}
