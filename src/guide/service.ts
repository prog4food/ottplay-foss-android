/** Schedules, in-flight requests and clock subscriptions have one owner. */
interface GuideReference {
    channelId: string;
    id: string | number;
    sourceId: string;
    token: any;
}
interface GuideProgramme {
    description: string;
    end: number;
    icon?: string;
    id: string;
    providerId?: string | number;
    start: number;
    title: string;
}
interface GuideProjection {
    current: GuideProgramme | null;
    following: GuideProgramme[];
    retryAt: number;
}
interface GuideServicePorts {
    capacity(): number;
    clearTimer(timer: any): void;
    context(): string;
    current(reference: GuideReference): boolean;
    decode(reference: GuideReference, rows: any): GuideProgramme[];
    fetch(
        reference: GuideReference,
        complete: (rows: any) => void
    ): (() => void) | void;
    nextCount(): number;
    now(): number;
    select(rows: GuideProgramme[], now: number, count: number): GuideProjection;
    timer(callback: () => void, delay: number): any;
}

function createGuideService(ports: GuideServicePorts) {
    type Consumer = {
        active: boolean;
        subscription?: boolean;
        notify: (rows: GuideProgramme[] | null) => void;
    };
    type Request = {
        cancel?: () => void;
        consumers: Consumer[];
        generation: number;
        key: string;
        reference: GuideReference;
    };
    type Current = {
        projection: GuideProjection;
        reference: GuideReference;
        listeners: Array<(value: GuideProjection) => void>;
        selectedAt: number;
    };
    var source = ports.context();
    var generation = 0;
    var cache: Record<
        string,
        { rows: GuideProgramme[]; time: number; token: any }
    > = Object.create(null);
    var order: string[] = [];
    var pending: Record<string, Request> = Object.create(null);
    var states: Record<string, Current> = Object.create(null);
    var queue: Request[] = [];
    var running: Request | null = null;
    var drainTimer: any = null;
    var clockTimer: any = null;
    var aligning = false;
    var disposed = false;
    function clone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value));
    }
    function removeGuideEntry<T>(items: T[], value: T): void {
        var at = items.indexOf(value);
        if (at >= 0) items.splice(at, 1);
    }
    function isActiveConsumer(consumer: Consumer): boolean {
        return consumer.active;
    }
    function ownsState(
        state: Current | undefined,
        reference: GuideReference
    ): state is Current {
        return !!state && state.reference.token === reference.token;
    }
    function key(reference: GuideReference): string {
        return (
            reference.sourceId.length +
            ":" +
            reference.sourceId +
            reference.channelId.length +
            ":" +
            reference.channelId
        );
    }
    function active(reference: GuideReference): boolean {
        return (
            !disposed &&
            source === ports.context() &&
            source === reference.sourceId &&
            ports.current(reference)
        );
    }
    function cancelRequest(request: Request, keepConsumers = false): void {
        request.consumers.forEach(function (consumer) {
            if (!keepConsumers) consumer.active = false;
        });
        if (request.cancel) {
            var cancel = request.cancel;
            request.cancel = undefined;
            try {
                cancel();
            } catch (_) {}
        }
    }
    function reset(nextSource: string, keepConsumers = false): void {
        generation++;
        source = nextSource;
        var previous = pending;
        pending = Object.create(null);
        queue = [];
        running = null;
        cache = Object.create(null);
        order = [];
        states = Object.create(null);
        ports.clearTimer(drainTimer);
        drainTimer = null;
        ports.clearTimer(clockTimer);
        clockTimer = null;
        Object.keys(previous).forEach(function (id) {
            cancelRequest(previous[id], keepConsumers);
        });
    }
    function synchronize(): void {
        if (source !== ports.context()) reset(ports.context());
    }
    function capacity(): number {
        var value = Number(ports.capacity());
        return isFinite(value) && value > 0
            ? Math.min(1000, Math.floor(value))
            : 0;
    }
    function touch(id: string): void {
        removeGuideEntry(order, id);
        order.push(id);
    }
    function read(reference: GuideReference): GuideProgramme[] | null {
        var id = key(reference),
            entry = cache[id];
        if (
            !active(reference) ||
            !capacity() ||
            !entry ||
            entry.token !== reference.token
        )
            return null;
        if (
            ports.now() - entry.time >= 12 * 60 * 60 ||
            !entry.rows.some(function (row) {
                return row.end > ports.now();
            })
        ) {
            delete cache[id];
            removeGuideEntry(order, id);
            return null;
        }
        touch(id);
        return clone(entry.rows);
    }
    function retain(reference: GuideReference, rows: GuideProgramme[]): void {
        var limit = capacity();
        if (!limit || !rows.length) return;
        var id = key(reference);
        cache[id] = {
            rows: clone(rows),
            time: ports.now(),
            token: reference.token,
        };
        touch(id);
        while (order.length > limit) delete cache[order.shift()!];
    }
    function project(reference: GuideReference, rows: GuideProgramme[]): void {
        var id = key(reference),
            previous = states[id],
            now = ports.now();
        var selection = clone(ports.select(rows, now, ports.nextCount()));
        var state: Current = {
            listeners: ownsState(previous, reference) ? previous.listeners : [],
            projection: selection,
            reference: reference,
            selectedAt: now,
        };
        states[id] = state;
        state.listeners.slice().forEach(function (notify) {
            if (active(reference) && states[id] === state) {
                try {
                    notify(clone(selection));
                } catch (_) {}
            }
        });
        scheduleClock();
    }
    // Forward reads inside [selectedAt, retryAt) stay read-only. A backward
    // epoch or an elapsed retry deadline reselects retained rows without
    // starting a fetch.
    function alignProjection(reference: GuideReference): boolean {
        if (aligning || !active(reference)) return false;
        var id = key(reference),
            state = states[id];
        if (!ownsState(state, reference) || pending[id]) return false;
        var now = ports.now();
        if (now >= state.selectedAt && now < state.projection.retryAt)
            return false;
        var rows = read(reference);
        if (!rows) return false;
        aligning = true;
        try {
            project(reference, rows);
        } finally {
            aligning = false;
        }
        return true;
    }
    function scheduleClock(): void {
        ports.clearTimer(clockTimer);
        clockTimer = null;
        var now = ports.now(),
            deadline = Infinity;
        Object.keys(states).forEach(function (id) {
            var state = states[id];
            if (
                state.listeners.length &&
                active(state.reference) &&
                !pending[id]
            )
                deadline = Math.min(deadline, state.projection.retryAt);
        });
        if (!isFinite(deadline)) return;
        var expected = generation;
        clockTimer = ports.timer(
            function () {
                clockTimer = null;
                if (
                    disposed ||
                    expected !== generation ||
                    source !== ports.context()
                )
                    return;
                Object.keys(states).forEach(function (id) {
                    var state = states[id];
                    if (!(state.listeners.length && active(state.reference)))
                        return;
                    if (alignProjection(state.reference)) return;
                    if (state.projection.retryAt <= ports.now())
                        observe(state.reference);
                });
                scheduleClock();
            },
            Math.max(1, Math.min(2147483647, (deadline - now) * 1000))
        );
    }
    function drain(): void {
        drainTimer = null;
        if (disposed || running) return;
        synchronize();
        while (queue.length) {
            var next = queue.shift()!;
            if (
                pending[next.key] !== next ||
                !active(next.reference) ||
                !next.consumers.some(isActiveConsumer)
            ) {
                if (pending[next.key] === next) delete pending[next.key];
                continue;
            }
            running = next;
            (function (current: Request) {
                var finished = false;
                function finish(raw: any): void {
                    if (
                        finished ||
                        pending[current.key] !== current ||
                        current.generation !== generation
                    )
                        return;
                    finished = true;
                    delete pending[current.key];
                    if (running === current) running = null;
                    // A retired row still releases its owned transport slot.
                    if (!active(current.reference)) {
                        scheduleDrain();
                        return;
                    }
                    var rows: GuideProgramme[] = [];
                    try {
                        rows = ports.decode(current.reference, raw);
                    } catch (_) {}
                    if (
                        !active(current.reference) ||
                        current.generation !== generation
                    ) {
                        scheduleDrain();
                        return;
                    }
                    retain(current.reference, rows);
                    project(current.reference, rows);
                    current.consumers.forEach(function (consumer) {
                        if (
                            consumer.active &&
                            active(current.reference) &&
                            current.generation === generation
                        ) {
                            consumer.active = false;
                            try {
                                if (!consumer.subscription)
                                    consumer.notify(
                                        rows.length ? clone(rows) : null
                                    );
                            } catch (_) {}
                        }
                    });
                    scheduleDrain();
                }
                try {
                    var cancel = ports.fetch(current.reference, finish);
                    if (
                        !finished &&
                        pending[current.key] === current &&
                        current.generation === generation &&
                        active(current.reference)
                    )
                        current.cancel = cancel || undefined;
                    else if (cancel) cancel();
                } catch (_) {
                    finish(null);
                }
            })(next);
            return;
        }
    }
    function scheduleDrain(): void {
        if (!running && drainTimer === null && queue.length)
            drainTimer = ports.timer(drain, 0);
    }
    function request(
        reference: GuideReference,
        notify: (rows: GuideProgramme[] | null) => void,
        previousConsumer?: Consumer
    ): () => void {
        synchronize();
        var consumer: Consumer = previousConsumer || {
            active: true,
            notify: notify,
        };
        if (!active(reference)) {
            consumer.active = false;
            return function () {};
        }
        var cached = read(reference);
        if (cached) {
            var expected = generation;
            project(reference, cached);
            if (
                !consumer.subscription &&
                generation === expected &&
                active(reference)
            )
                notify(clone(cached));
            consumer.active = false;
            return function () {};
        }
        var id = key(reference),
            existing = pending[id];
        if (existing && existing.reference.token !== reference.token) {
            delete pending[id];
            if (running === existing) running = null;
            cancelRequest(existing);
            existing = pending[id];
            if (
                !active(reference) ||
                (existing && existing.reference.token !== reference.token)
            ) {
                consumer.active = false;
                return function () {};
            }
        }
        if (!existing) {
            existing = {
                consumers: [],
                generation: generation,
                key: id,
                reference: reference,
            };
            pending[id] = existing;
            queue.push(existing);
        }
        existing.consumers.push(consumer);
        scheduleDrain();
        return function () {
            if (!consumer.active) return;
            consumer.active = false;
            var owned = pending[id];
            if (
                owned &&
                owned.consumers.indexOf(consumer) >= 0 &&
                !owned.consumers.some(isActiveConsumer)
            ) {
                delete pending[id];
                if (running === owned) running = null;
                cancelRequest(owned);
                scheduleDrain();
                scheduleClock();
            }
        };
    }
    function observe(reference: GuideReference): () => void {
        var consumer: Consumer = {
            active: true,
            notify: function () {},
            subscription: true,
        };
        return request(reference, consumer.notify, consumer);
    }
    function retireObservers(reference: GuideReference): void {
        var id = key(reference),
            current = pending[id];
        if (!current || current.reference.token !== reference.token) return;
        current.consumers.forEach(function (consumer) {
            if (consumer.subscription) consumer.active = false;
        });
        if (!current.consumers.some(isActiveConsumer)) {
            delete pending[id];
            if (running === current) running = null;
            cancelRequest(current);
            scheduleDrain();
        }
    }
    var api = {
        cached: function () {
            synchronize();
            var result: Array<{
                reference: GuideReference;
                rows: GuideProgramme[];
            }> = [];
            Object.keys(states).forEach(function (id) {
                var state = states[id],
                    rows = read(state.reference);
                if (rows)
                    result.push({ reference: state.reference, rows: rows });
            });
            return result;
        },
        dispose: function () {
            if (!disposed) {
                disposed = true;
                reset(source);
            }
        },
        field: function (reference: GuideReference, field: string): any {
            synchronize();
            alignProjection(reference);
            var state = states[key(reference)];
            if (!state || !active(reference) || !ownsState(state, reference))
                return undefined;
            if (field === "following") return clone(state.projection.following);
            if (field === "retryAt")
                return state.projection.current ? 0 : state.projection.retryAt;
            if (field === "missing") return !state.projection.current;
            return state.projection.current
                ? (state.projection.current as any)[field]
                : undefined;
        },
        invalidate: function (refetch: boolean) {
            var waiting = Object.keys(pending).map(function (id) {
                    return {
                        consumers:
                            pending[id].consumers.filter(isActiveConsumer),
                        reference: pending[id].reference,
                    };
                }),
                oldStates = states,
                expected = generation + 1;
            reset(ports.context(), refetch);
            if (!refetch || disposed || generation !== expected) return;
            Object.keys(oldStates).forEach(function (id) {
                var state = oldStates[id];
                if (active(state.reference) && state.listeners.length) {
                    var now = ports.now();
                    states[id] = {
                        listeners: state.listeners.slice(),
                        projection: ports.select([], now, ports.nextCount()),
                        reference: state.reference,
                        selectedAt: now,
                    };
                    observe(state.reference);
                }
            });
            waiting.forEach(function (item) {
                if (generation === expected && active(item.reference))
                    item.consumers.forEach(function (consumer) {
                        if (consumer.active)
                            request(item.reference, consumer.notify, consumer);
                    });
            });
        },
        invalidateChannel: function (
            reference: GuideReference,
            keepProjection = false
        ) {
            synchronize();
            var id = key(reference),
                previous = pending[id];
            delete cache[id];
            if (!keepProjection) delete states[id];
            else if (states[id]) states[id].projection.retryAt = 0;
            delete pending[id];
            if (running === previous) running = null;
            removeGuideEntry(order, id);
            if (previous) cancelRequest(previous);
            scheduleDrain();
            scheduleClock();
        },
        peek: function (reference: GuideReference) {
            synchronize();
            return read(reference);
        },
        publish: function (reference: GuideReference, rows: GuideProgramme[]) {
            synchronize();
            if (active(reference)) project(reference, clone(rows));
        },
        request: request,
        seed: function (reference: GuideReference, raw: any) {
            synchronize();
            if (!active(reference)) return;
            var rows = ports.decode(reference, raw);
            retain(reference, rows);
            project(reference, rows);
        },
        snapshot: function (reference: GuideReference): GuideProjection | null {
            synchronize();
            alignProjection(reference);
            var state = states[key(reference)];
            return state && active(reference) && ownsState(state, reference)
                ? clone(state.projection)
                : null;
        },
        subscribe: function (
            reference: GuideReference,
            notify: (projection: GuideProjection) => void
        ) {
            synchronize();
            var id = key(reference),
                state = states[id];
            if (!active(reference)) return function () {};
            var initial = !ownsState(state, reference);
            if (initial) {
                project(reference, []);
                state = states[id];
            }
            state.listeners.push(notify);
            var cancel =
                initial || state.projection.retryAt <= ports.now()
                    ? observe(reference)
                    : function () {};
            scheduleClock();
            return function () {
                cancel();
                var current = states[id];
                if (!ownsState(current, reference)) return;
                removeGuideEntry(current.listeners, notify);
                if (!current.listeners.length) retireObservers(reference);
                scheduleClock();
            };
        },
    };
    return api;
}

(window as any).__ottGuideService = { create: createGuideService };
