/** A decoder lease belongs to one request; observers never own transport methods. */
interface MediaBackendContext {
    active?(): boolean;
    generation: number;
    kind: string;
    position: number;
    sourceActive?(): boolean;
}
interface MediaBackendRequest {
    context?: MediaBackendContext;
    lane?: string;
    paused?: boolean;
    position?: number;
    sourceUrl?: string;
    timelineOffset?: number;
    transient?: boolean;
    url: string;
}
interface MediaBackendSample {
    duration: number;
    paused: boolean;
    position: number;
    ready: number;
}
type MediaDiagnosticEngine = "hls.js" | "shaka" | "html5" | null;
interface MediaEngineLease {
    // Counters belong to this engine attachment, not the saved player mode.
    diagnosticAttempt?(): {
        engineStarts: number;
        fatalErrors: number;
        nativeFallbacks: number;
        streamRetries: number;
    } | null;
    // Read-only identity of the attached engine, never a saved preference.
    diagnosticEngine?(): MediaDiagnosticEngine;
    dispose(replaced?: boolean): void;
    pause(): void;
    resume(): void;
    sample(): MediaBackendSample;
    seek(position: number): void;
    selectTrack?(kind: string, index: number): void;
    // The engine honors request.paused before any immediate or deferred startup.
    supportsPausedStart?: boolean;
    tracks?(kind: string): any;
}
interface MediaBackendPorts {
    admitted?(): boolean;
    clearInterval(timer: any): void;
    context(): MediaBackendContext | null;
    emit(
        context: MediaBackendContext,
        type: string,
        position?: number,
        duration?: number
    ): void;
    open(
        request: MediaBackendRequest,
        event: (type: string) => void
    ): MediaEngineLease;
    resolve?(url: string, done: (url: string | null) => void): () => void;
    setInterval(callback: () => void, delay: number): any;
}
function createMediaBackend(ports: MediaBackendPorts) {
    var sequence = 0;
    var lanes: { [lane: string]: any } = {};
    // One bounded tombstone per video lane survives synchronous EOF disposal.
    var lastAttempts: { [lane: string]: any } = {};
    var subscribers: Array<(event: any) => void> = [];
    var seeks: {
        [lane: string]: {
            handle: any;
            run(value: number, rebind: boolean): void;
        };
    } = {};
    function publish(handle: any, type: string) {
        var event = {
            handle: handle,
            id: handle.id,
            lane: handle.lane,
            type: type,
        };
        subscribers.slice().forEach(function (callback) {
            callback(event);
        });
    }
    function open(
        request: MediaBackendRequest,
        previewEvent?: (handle: any, type: string) => void
    ): any {
        if (ports.admitted && !ports.admitted()) return null;
        function announce(type: string): void {
            if (previewEvent) previewEvent(handle, type);
            else publish(handle, type);
        }
        var lane = request.lane || "main";
        var previous = lanes[lane];
        var inputContext = previewEvent
            ? null
            : request.context || ports.context();
        var context = inputContext
            ? {
                  active: inputContext.active,
                  generation: inputContext.generation,
                  kind: inputContext.kind,
                  position: inputContext.position,
                  sourceActive: inputContext.sourceActive,
              }
            : null;
        var engine: MediaEngineLease | null = null;
        var suspended = false;
        var attachment = 0;
        var cancelResolve = function () {};
        var alive = true;
        var timer: any = null;
        var phase = "loading";
        var awaitingRecovery = false;
        var retainPause = request.paused === true;
        var restorePlaying = false;
        var applyingPause = false;
        var desired = context
            ? context.position
            : Number(request.position) || 0;
        var offset: number | null =
            context && context.kind === "archive"
                ? request.timelineOffset === undefined
                    ? null
                    : request.timelineOffset
                : 0;
        var position = desired;
        var duration = NaN;
        var pendingEvents: string[] = [];
        function updateTimer() {
            if (phase !== "playing" && timer !== null) {
                ports.clearInterval(timer);
                timer = null;
            }
            if (
                current() &&
                phase === "playing" &&
                lane === "main" &&
                context &&
                timer === null
            )
                timer = ports.setInterval(function () {
                    observe();
                }, 1000);
        }
        function current() {
            return alive && lanes[lane] === handle;
        }
        function domainCurrent() {
            var now = ports.context();
            return (
                !!context &&
                (!context.active || context.active()) &&
                !!now &&
                now.generation === context.generation
            );
        }
        function command(type: string) {
            if (!previewEvent && lane === "main" && context && domainCurrent())
                ports.emit(context, type, position, duration);
        }
        function readAttempt() {
            var value =
                engine &&
                engine.diagnosticAttempt &&
                engine.diagnosticAttempt();
            if (!value) return null;
            return {
                attachment: attachment,
                engineStarts: value.engineStarts,
                fatalErrors: value.fatalErrors,
                nativeFallbacks: value.nativeFallbacks,
                streamRetries: value.streamRetries,
            };
        }
        function retainAttempt(reason: string): void {
            if (!current() || (lane !== "main" && lane !== "pip")) return;
            try {
                var value = readAttempt();
                if (!value) return;
                var previous = lastAttempts[lane];
                if (
                    previous &&
                    previous.handleId === handle.id &&
                    previous.attachment === attachment &&
                    previous.reason === "ended"
                )
                    return;
                lastAttempts[lane] = Object.assign(value, {
                    generation: context ? context.generation : null,
                    handleId: handle.id,
                    reason: reason,
                });
            } catch (_) {
                // Observation failure must never prevent transport teardown.
            }
        }
        function refreshContext() {
            var latest = ports.context();
            if (context && latest && latest.generation === context.generation)
                if (context.kind !== latest.kind) {
                    context.kind = latest.kind;
                    context.active = latest.active;
                    context.sourceActive = latest.sourceActive;
                }
        }
        function observe(type?: string) {
            if (!current() || suspended || phase === "stopped") return;
            if (!engine) {
                pendingEvents.push(type || "sample");
                return;
            }
            if (type === "error") {
                if (!handle.active() || awaitingRecovery) return;
                // Native and MSE errors may trigger an in-place engine fallback.
                // Stop reporting play while preserving that lease's recovery.
                awaitingRecovery = true;
                phase = "loading";
                command("loading");
                updateTimer();
                if (current()) announce("error");
                return;
            }
            if (type === "ended" && awaitingRecovery) return;
            refreshContext();
            var sample = engine.sample();
            // A resolver or engine may report autoplay after the lease attaches.
            // Only restart requests retain pause; ordinary native controls may resume directly.
            if (retainPause && handle.active() && type !== "ended") {
                if (type === "playing" && sample.ready >= 2)
                    restorePlaying = true;
                if (!sample.paused && !applyingPause) {
                    applyingPause = true;
                    try {
                        engine.pause();
                    } finally {
                        applyingPause = false;
                    }
                    if (!handle.active()) return;
                    sample = engine.sample();
                }
                if (sample.paused) {
                    // Once startup playback was actually paused, native controls
                    // own later playing events just like an ordinary lease.
                    if (restorePlaying) retainPause = false;
                    phase = "paused";
                    if (type === "playing") type = "pause";
                } else if (type === "playing") type = "position";
            }
            if (type === "pause" && phase !== "playing") type = "position";
            if (type === "playing" && !sample.paused && sample.ready >= 2) {
                awaitingRecovery = false;
                phase = "playing";
                command("playing");
            } else if (
                type === "pause" &&
                sample.paused &&
                phase === "playing"
            ) {
                phase = "paused";
                command("pause");
            } else if (type === "ended") {
                if (!handle.active()) return;
                // The last timer tick can precede EOF by a full second. Publish
                // the decoder's final media clock before stop freezes state.
                if (
                    context?.kind === "vod" &&
                    isFinite(sample.position) &&
                    sample.position >= 0
                ) {
                    position = sample.position;
                    duration = sample.duration;
                    command("position");
                    if (!handle.active()) return;
                }
                // emit may synchronously stop and dispose the underlying engine.
                retainAttempt("ended");
                phase = "stopped";
                command("ended");
            }
            if (
                sample.ready >= 1 &&
                (phase === "playing" || phase === "paused")
            ) {
                if (offset === null) offset = desired - sample.position;
                var measured = sample.position + offset;
                if (isFinite(measured) && measured >= 0) position = measured;
                duration = sample.duration;
                if (!context || context.kind !== "live") command("position");
            }
            updateTimer();
            if (current()) announce(type || "position");
        }
        function seek(value: number, rebind: boolean) {
            if (!current() || !engine || !isFinite(value) || value < 0) return;
            if (
                !handle.active() &&
                (!rebind ||
                    !context ||
                    !context.sourceActive ||
                    !context.sourceActive())
            )
                return;
            if (previewEvent) {
                engine.seek(value);
                if (current()) observe("position");
                return;
            }
            var next = ports.context();
            if (
                !handle.active() &&
                (!next || !context || next.kind !== context.kind)
            )
                return;
            if (next)
                context = {
                    active: next.active,
                    generation: next.generation,
                    kind: next.kind,
                    position: next.position,
                    sourceActive: next.sourceActive,
                };
            desired = context ? context.position : value;
            offset =
                context && context.kind === "archive" ? desired - value : 0;
            position = context && context.kind === "archive" ? desired : value;
            engine.seek(value);
            if (!current()) return;
            command("position");
            // An archive seek can rebind the same decoder to a fresh domain generation.
            var sample = engine.sample();
            if (sample.paused) {
                phase = "paused";
                command("pause");
            } else if (sample.ready >= 2) {
                awaitingRecovery = false;
                phase = "playing";
                command("playing");
            }
            updateTimer();
            announce("seek");
        }
        function attachEngine() {
            if (!handle.active() || suspended) return;
            var token = ++attachment;
            var resolved = false;
            function valid() {
                return handle.active() && !suspended && token === attachment;
            }
            function attach(url: string | null) {
                if (resolved || !valid()) return;
                resolved = true;
                if (!url) {
                    command("stop");
                    announce("error");
                    handle.dispose();
                    return;
                }
                var opened: MediaEngineLease;
                try {
                    opened = ports.open(
                        {
                            context: request.context,
                            lane: request.lane,
                            paused: request.paused,
                            position: request.position,
                            sourceUrl: request.url,
                            transient: !!previewEvent,
                            url: url,
                        },
                        function (type: string) {
                            if (valid()) observe(type);
                        }
                    );
                } catch (error) {
                    if (current()) command("stop");
                    handle.dispose();
                    throw error;
                }
                if (!valid()) {
                    opened.dispose();
                    return;
                }
                engine = opened;
                if (retainPause) {
                    if (engine.supportsPausedStart === true)
                        retainPause = false;
                    phase = "paused";
                    command("pause");
                    if (!handle.active()) return;
                    engine.pause();
                    if (!current()) return;
                }
                announce("open");
                if (!current()) return;
                pendingEvents.forEach(observe);
                pendingEvents = [];
                if (current()) updateTimer();
            }
            try {
                if (ports.resolve) {
                    var cancel = ports.resolve(request.url, attach);
                    if (valid()) cancelResolve = cancel;
                    else cancel();
                } else attach(request.url);
            } catch (error) {
                if (current()) command("stop");
                handle.dispose();
                throw error;
            }
        }
        var handle: any = {
            active: function () {
                return (
                    (!ports.admitted || ports.admitted()) &&
                    current() &&
                    (lane !== "main" || !context || domainCurrent())
                );
            },
            diagnosticAttempt: function () {
                return handle.active() && !suspended && phase !== "stopped"
                    ? readAttempt()
                    : null;
            },
            diagnosticEngine: function (): MediaDiagnosticEngine {
                return handle.active() &&
                    !suspended &&
                    phase !== "stopped" &&
                    engine &&
                    engine.diagnosticEngine
                    ? engine.diagnosticEngine()
                    : null;
            },
            dispose: function (replaced?: boolean) {
                if (!alive) return;
                retainAttempt("disposed");
                alive = false;
                attachment++;
                cancelResolve();
                if (lanes[lane] === handle) {
                    delete lanes[lane];
                    delete seeks[lane];
                }
                if (timer !== null) ports.clearInterval(timer);
                timer = null;
                // The engine lease checks its own generation before releasing a shared decoder.
                if (engine) engine.dispose(replaced);
                phase = "stopped";
                announce("dispose");
            },
            id: ++sequence,
            lane: lane,
            pause: function () {
                if (!handle.active() || !engine) return;
                phase = "paused";
                updateTimer();
                command("pause");
                if (!current()) return;
                engine.pause();
                if (current()) announce("pause");
            },
            previewRestore: function () {
                if (
                    lane !== "main" ||
                    !context ||
                    context.kind !== "live" ||
                    !engine ||
                    !handle.active() ||
                    (phase !== "playing" && phase !== "paused")
                )
                    return null;
                var sample = engine.sample();
                if (!handle.active()) return null;
                var paused = phase === "paused" || sample.paused;
                return function () {
                    if (!domainCurrent()) return null;
                    return open({
                        context: context || undefined,
                        lane: "main",
                        paused: paused,
                        position: 0,
                        url: request.url,
                    });
                };
            },
            restart: function () {
                if (
                    lane !== "main" ||
                    !context ||
                    ["live", "archive", "vod"].indexOf(context.kind) < 0 ||
                    !engine ||
                    !handle.active() ||
                    phase === "stopped"
                )
                    return null;
                observe();
                if (!handle.active() || !engine) return null;
                var sample = engine.sample();
                var nextContext = ports.context();
                if (!handle.active() || !nextContext) return null;
                var live = context.kind === "live";
                if (
                    !live &&
                    (sample.ready < 1 ||
                        (phase !== "playing" && phase !== "paused") ||
                        !isFinite(sample.position) ||
                        sample.position < 0 ||
                        !isFinite(position) ||
                        position < 0)
                )
                    return null;
                var paused =
                    retainPause ||
                    phase === "paused" ||
                    (sample.ready >= 1 && sample.paused);
                var savedPosition = live ? 0 : position;
                var next = open({
                    context: {
                        active: nextContext.active,
                        generation: nextContext.generation,
                        kind: nextContext.kind,
                        position: savedPosition,
                        sourceActive: nextContext.sourceActive,
                    },
                    lane: "main",
                    paused: paused,
                    position: live ? 0 : sample.position,
                    timelineOffset: live ? 0 : position - sample.position,
                    url: request.url,
                });
                return next && next.active()
                    ? {
                          accepted: true,
                          dispatched: true,
                          kind: nextContext.kind,
                          paused: paused,
                          position: savedPosition,
                          target: "stream",
                      }
                    : null;
            },
            resume: function () {
                if (!handle.active()) return;
                if (suspended) {
                    suspended = false;
                    retainPause = false;
                    phase = "loading";
                    awaitingRecovery = false;
                    // Live manifests/sessions expire while asleep. Resolve a new
                    // transport from the original URL; VOD keeps its media cursor.
                    request.position =
                        context && context.kind === "live"
                            ? 0
                            : Math.max(0, position - (offset || 0));
                    request.paused = false;
                    command("loading");
                    if (current() && !suspended) attachEngine();
                    return;
                }
                if (!engine) return;
                retainPause = false;
                engine.resume();
                if (!current()) return;
                var sample = engine.sample();
                var type = sample.paused
                    ? "pause"
                    : sample.ready >= 2
                      ? "resume"
                      : "loading";
                phase =
                    type === "pause"
                        ? "paused"
                        : type === "resume"
                          ? "playing"
                          : "loading";
                if (phase === "playing") awaitingRecovery = false;
                updateTimer();
                command(type);
                announce(type);
            },
            sample: function () {
                observe();
            },
            seek: function (value: number) {
                seek(value, false);
            },
            selectTrack: function (kind: string, index: number) {
                if (handle.active() && engine && engine.selectTrack)
                    engine.selectTrack(kind, index);
            },
            snapshot: function () {
                return {
                    duration: duration,
                    id: handle.id,
                    lane: lane,
                    phase: phase,
                    position: position,
                };
            },
            suspend: function () {
                if (!handle.active() || suspended || phase === "stopped")
                    return;
                // Retire callbacks before reading the decoder: a native sample
                // can synchronously emit EOF and select the next local file.
                suspended = true;
                retainAttempt("suspended");
                attachment++;
                try {
                    refreshContext();
                    var sample = engine && engine.sample();
                    if (sample && sample.ready >= 1) {
                        if (offset === null) offset = desired - sample.position;
                        var measured = sample.position + offset;
                        if (isFinite(measured) && measured >= 0)
                            position = measured;
                        duration = sample.duration;
                    }
                } catch (_) {
                    // A disappearing decoder must still release its transport.
                }
                cancelResolve();
                cancelResolve = function () {};
                pendingEvents = [];
                // Keep the logical lease and cursor, but release every transport,
                // decoder and deferred startup owned by its engine.
                var retired = engine;
                engine = null;
                phase = "paused";
                updateTimer();
                if (retired) retired.dispose();
                if (!current()) return;
                if (!context || context.kind !== "live") command("position");
                if (!current()) return;
                command("pause");
                announce("suspend");
            },
            tracks: function (kind: string) {
                return handle.active() && engine && engine.tracks
                    ? engine.tracks(kind)
                    : null;
            },
        };
        lanes[lane] = handle;
        seeks[lane] = { handle: handle, run: seek };
        if (previous) previous.dispose(true);
        if (!current()) return handle;
        command("loading");
        if (!current()) return handle;
        attachEngine();
        return handle;
    }
    return {
        current: function (lane?: string) {
            return lanes[lane || "main"] || null;
        },
        dispose: function () {
            var retired = lanes;
            lanes = {};
            Object.keys(retired).forEach(function (lane) {
                retired[lane].dispose();
            });
        },
        lastAttempt: function (lane?: string) {
            var value = lastAttempts[lane || "main"];
            return value ? Object.assign({}, value) : null;
        },
        open: open,
        preview: function (url: string, closed?: (reason: string) => void) {
            var previous = lanes.main;
            var restore = previous && previous.previewRestore();
            if (previous && !restore) return null;
            var finished = false;
            function finish(
                handle: any,
                resume: boolean,
                reason: string
            ): void {
                if (finished) return;
                finished = true;
                var owns = lanes.main === handle;
                if (owns) handle.dispose();
                if (closed) closed(reason);
                // A callback may select another channel; never replace that new owner.
                if (owns && resume && !lanes.main && restore) restore();
            }
            var handle: any;
            try {
                handle = open(
                    { lane: "main", url: url },
                    function (current: any, type: string) {
                        if (type === "ended" || type === "error")
                            finish(current, true, type);
                        else if (type === "dispose")
                            finish(current, false, type);
                    }
                );
            } catch (_) {
                // Startup teardown already closes the preview; restore only if no
                // reentrant replacement took ownership while the engine failed.
                if (!lanes.main && restore) {
                    try {
                        restore();
                    } catch (_) {
                        /* The original source also failed. */
                    }
                }
                return null;
            }
            return {
                active: function () {
                    return !finished && lanes.main === handle;
                },
                finish: function () {
                    finish(handle, true, "cancel");
                },
            };
        },
        restart: function () {
            var handle = lanes.main;
            return handle ? handle.restart() : null;
        },
        seek: function (value: number) {
            var operation = seeks.main;
            if (operation && operation.handle === lanes.main)
                operation.run(value, true);
        },
        stop: function (lane?: string) {
            var handle = lanes[lane || "main"];
            var context = ports.context();
            if ((!lane || lane === "main") && context)
                ports.emit(context, "stop");
            if (handle) handle.dispose();
        },
        subscribe: function (callback: (event: any) => void) {
            subscribers.push(callback);
            return function () {
                var index = subscribers.indexOf(callback);
                if (index >= 0) subscribers.splice(index, 1);
            };
        },
    };
}
(window as any).__ottMediaBackend = { create: createMediaBackend };
