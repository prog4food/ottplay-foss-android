/** Native PiP has a request identity even while its asynchronous decoder is starting. */
function createNativePipPort(ports: any) {
    var sequence = ports.seed || 0;
    var pending: any = null;
    function invoke(action: string, args: any, active?: () => boolean): any {
        function run() {
            if (!active || active()) return ports.invoke(action, args);
        }
        var task: any;
        try {
            // Stop cancels native startup. Queue the next play behind teardown,
            // rather than holding cancellation behind the readiness it aborts.
            task =
                ports.serial && action !== "stop"
                    ? (pending || Promise.resolve()).then(run)
                    : Promise.resolve(run());
        } catch (error) {
            task = Promise.reject(error);
        }
        if (ports.serial) {
            pending = task.then(
                function () {},
                function () {}
            );
            var saved = pending;
            pending.then(function () {
                if (pending === saved) pending = null;
            });
        }
        return task;
    }
    return {
        open: function (
            request: any,
            fallback: (url: string) => MediaEngineLease
        ): MediaEngineLease {
            var id = ++sequence;
            var alive = true;
            var nativeStarted = false;
            var fallbackUrl = request.url;
            var css: MediaEngineLease | null = null;
            var cancelPreparation: (() => void) | null = null;
            function current() {
                return alive && sequence === id;
            }
            function fail(error: any) {
                if (!current()) return;
                ports.error(error);
                if (!current()) return;
                var opened = fallback(fallbackUrl);
                if (!current()) opened.dispose();
                else css = opened;
            }
            function play(args: any) {
                return invoke("play", args, function () {
                    if (!current()) return false;
                    nativeStarted = true;
                    return true;
                }).then(function (response: any) {
                    if (!current()) return;
                    if (
                        (response &&
                            (response.ok === false || response.unsupported)) ||
                        (ports.requireOk && (!response || !response.ok))
                    ) {
                        fail(response);
                        return;
                    }
                    ports.ready();
                }, fail);
            }
            var args = ports.request(request.url, id);
            if (ports.prepare) {
                // Sign-in must not occupy the native command queue: Stop stays
                // responsive while a browser prompt is open. A rejected sign-in
                // must never start the unauthenticated CSS fallback.
                function preparationFailed(error: any) {
                    cancelPreparation = null;
                    if (current()) ports.error(error);
                }
                try {
                    Promise.resolve(
                        ports.prepare(args, function (cancel: () => void) {
                            if (current()) cancelPreparation = cancel;
                            else cancel();
                        })
                    ).then(function (prepared) {
                        cancelPreparation = null;
                        if (current()) {
                            fallbackUrl = prepared.url;
                            play(prepared);
                        }
                    }, preparationFailed);
                } catch (error) {
                    preparationFailed(error);
                }
            } else play(args);
            return {
                dispose: function (replaced?: boolean) {
                    if (!alive) return;
                    alive = false;
                    if (cancelPreparation) {
                        cancelPreparation();
                        cancelPreparation = null;
                    }
                    if (css) css.dispose();
                    if (sequence !== id) return;
                    var stopId = ++sequence;
                    function stop() {
                        if (sequence === stopId)
                            invoke("stop", { requestId: stopId }).catch(
                                ports.error
                            );
                    }
                    // Preparation can wait for sign-in or fail before a replacing
                    // play reaches native code. Retire any started decoder now;
                    // its replacement waits only for teardown acknowledgement.
                    if (replaced && ports.prepare) {
                        if (nativeStarted) stop();
                    } else if (replaced) Promise.resolve().then(stop);
                    else stop();
                },
                pause: function () {
                    if (current() && css) css.pause();
                },
                resume: function () {
                    if (current() && css) css.resume();
                },
                sample: function () {
                    return css
                        ? css.sample()
                        : {
                              duration: NaN,
                              paused: false,
                              position: 0,
                              ready: 2,
                          };
                },
                seek: function (position: number) {
                    if (current() && css) css.seek(position);
                },
            };
        },
    };
}
(window as any).__ottNativePip = { create: createNativePipPort };
