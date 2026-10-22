const assert = require("node:assert/strict");
const vm = require("node:vm");
const runtime = require("./helpers/private-runtime.cjs");
function fixture(capacity = 8, options = {}) {
    const independent = options.independentClock === true;
    let source = "one",
        now = 100,
        epoch = 100,
        elapsed = 0,
        nextTimer = 0;
    const tokens = { 1: {}, 2: {} };
    const timers = new Map(),
        requests = [];
    const host = {};
    host.window = host;
    vm.createContext(host);
    require("./helpers/shared-core-runtime.cjs")(host);
    runtime(host, "src/guide/service.ts");
    const service = host.__ottGuideService.create({
        capacity: () => capacity,
        clearTimer: (id) => timers.delete(id),
        context: () => source,
        current: (ref) =>
            ref.sourceId === source && ref.token === tokens[ref.id],
        decode: (_ref, rows) =>
            Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [],
        fetch(ref, done) {
            const request = { canceled: 0, done, ref };
            requests.push(request);
            return () => {
                request.canceled++;
                if (request.onCancel) request.onCancel();
            };
        },
        nextCount: () => 2,
        now: () => (independent ? epoch : now),
        select(rows, time, count) {
            const selected = host.OttPlayCore.guideScheduleSelection(
                rows,
                time,
                count
            );
            if (options.afterSelect) options.afterSelect();
            return selected;
        },
        timer(fn, delay) {
            const id = ++nextTimer;
            const wait = Math.max(0, Number(delay) || 0);
            timers.set(
                id,
                independent
                    ? { delay: wait, due: elapsed + wait, fn }
                    : { at: now + wait / 1000, fn }
            );
            return id;
        },
    });
    return {
        advance(value) {
            now = value;
        },
        advanceElapsed(ms) {
            if (!independent) throw Error("independent clock required");
            const target = elapsed + ms;
            const started = elapsed;
            const startedEpoch = epoch;
            for (let limit = 0; limit < 100; limit++) {
                const due = [...timers]
                    .filter(([, timer]) => timer.due <= target)
                    .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
                if (!due) {
                    elapsed = target;
                    epoch = startedEpoch + ms / 1000;
                    return;
                }
                elapsed = due[1].due;
                epoch = startedEpoch + (elapsed - started) / 1000;
                timers.delete(due[0]);
                due[1].fn();
            }
            throw Error("unbounded guide timer loop");
        },
        elapsed: () => elapsed,
        epoch: () => epoch,
        flush() {
            for (let limit = 0; limit < 100; limit++) {
                const due = [...timers]
                    .filter(([, timer]) => timer.at <= now)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) return;
                timers.delete(due[0]);
                due[1].fn();
            }
            throw Error("unbounded guide timer loop");
        },
        ref: (id = 1) => ({
            channelId: "channel:" + id,
            id,
            sourceId: source,
            token: tokens[id],
        }),
        requests,
        service,
        setEpoch(value) {
            if (!independent) throw Error("independent clock required");
            epoch = value;
        },
        source(value) {
            source = value;
        },
        timers,
        tokens,
    };
}
const programme = (id, start = 90, end = 110) => ({
    description: "",
    end,
    id,
    start,
    title: id,
});
let passed = 0;
function check(name, run) {
    run();
    passed++;
    console.log("PASS guide service: " + name);
}
check("coalesces requests and detaches every response/projection", () => {
    const f = fixture(),
        got = [];
    f.service.request(f.ref(), (rows) => {
        got.push(rows);
        rows[0].title = "mutated";
    });
    f.service.request(f.ref(), (rows) => got.push(rows));
    f.flush();
    assert.equal(f.requests.length, 1);
    f.requests[0].done([programme("A")]);
    assert.equal(got[1][0].title, "A");
    assert.equal(f.service.peek(f.ref())[0].title, "A");
    const snapshot = f.service.snapshot(f.ref());
    snapshot.current.title = "changed";
    assert.equal(f.service.snapshot(f.ref()).current.title, "A");
});
check(
    "subscription projections and explicit responses stay independently detached",
    () => {
        const f = fixture(),
            projections = [],
            responses = [];
        f.service.subscribe(f.ref(), (value) => {
            projections.push(value.current && value.current.id);
            if (value.current) value.current.title = "subscriber mutation";
        });
        f.service.request(f.ref(), (rows) => {
            responses.push(rows);
            rows[0].title = "request mutation";
        });
        f.flush();
        f.requests[0].done([
            programme("current", 90, 110),
            programme("next", 110, 130),
        ]);
        f.service.request(f.ref(), (rows) => responses.push(rows));
        assert.equal(responses[1][0].title, "current");
        assert.equal(f.service.snapshot(f.ref()).current.title, "current");
        f.advance(110);
        f.flush();
        assert.equal(
            f.requests.length,
            1,
            "clock projects the retained schedule"
        );
        assert.equal(projections.at(-1), "next");
        assert.equal(f.service.snapshot(f.ref()).current.title, "next");
    }
);
check(
    "published schedules, subscribers, and later snapshots never share programme objects",
    () => {
        const f = fixture(),
            received = [];
        f.service.subscribe(f.ref(), (projection) => {
            if (!projection.current) return;
            projection.current.title = "first subscriber";
            projection.following[0].title = "first following";
            projection.following.push(programme("extra"));
        });
        f.service.subscribe(f.ref(), (projection) => received.push(projection));
        const rows = [
            programme("current", 90, 110),
            programme("next", 110, 130),
        ];
        f.service.publish(f.ref(), rows);
        assert.equal(rows[0].title, "current");
        assert.equal(rows[1].title, "next");
        rows[0].title = "publisher mutation";
        rows[1].title = "publisher next mutation";
        assert.equal(received.at(-1).current.title, "current");
        assert.equal(received.at(-1).following[0].title, "next");
        assert.equal(received.at(-1).following.length, 1);

        const snapshot = f.service.snapshot(f.ref());
        received.at(-1).current.title = "late subscriber mutation";
        received.at(-1).following[0].title = "late following mutation";
        snapshot.current.title = "snapshot mutation";
        snapshot.following[0].title = "snapshot following mutation";
        snapshot.following.length = 0;
        const following = f.service.field(f.ref(), "following");
        following[0].title = "field mutation";
        following.length = 0;
        const fresh = f.service.snapshot(f.ref());
        assert.equal(fresh.current.title, "current");
        assert.equal(fresh.following[0].title, "next");
        assert.equal(fresh.following.length, 1);
    }
);
check(
    "last consumer cancellation aborts without rejecting another consumer",
    () => {
        const f = fixture(),
            got = [];
        const a = f.service.request(f.ref(), () => got.push("a")),
            b = f.service.request(f.ref(), () => got.push("b"));
        f.flush();
        a();
        assert.equal(f.requests[0].canceled, 0);
        b();
        assert.equal(f.requests[0].canceled, 1);
        f.requests[0].done([programme("late")]);
        assert.deepEqual(got, []);
        assert.equal(f.service.snapshot(f.ref()), null);
    }
);
check(
    "old source completion cannot populate replacement cache or subscribers",
    () => {
        const f = fixture(),
            got = [];
        f.service.request(f.ref(), () => got.push("old"));
        f.flush();
        f.source("two");
        f.service.request(f.ref(), () => got.push("new"));
        f.flush();
        assert.equal(f.requests[0].canceled, 1);
        f.requests[0].done([programme("old")]);
        f.requests[1].done([programme("new")]);
        assert.deepEqual(got, ["new"]);
        assert.equal(f.service.peek(f.ref())[0].id, "new");
    }
);
check("clock follows half-open/latest-start schedule boundaries", () => {
    const f = fixture();
    f.service.subscribe(f.ref(), () => {});
    f.flush();
    f.requests[0].done([
        programme("long", 90, 120),
        programme("overlap", 105, 110),
        programme("next", 120, 140),
    ]);
    assert.equal(f.service.snapshot(f.ref()).current.id, "long");
    f.advance(105);
    f.flush();
    assert.equal(f.service.snapshot(f.ref()).current.id, "overlap");
    f.advance(110);
    f.flush();
    assert.equal(f.service.snapshot(f.ref()).current.id, "long");
    f.advance(120);
    f.flush();
    assert.equal(f.service.snapshot(f.ref()).current.id, "next");
    assert.equal(f.requests.length, 1);
});
check(
    "disabled full cache refetches at expiry once and keeps only projection",
    () => {
        const f = fixture(0);
        f.service.subscribe(f.ref(), () => {});
        f.flush();
        f.requests[0].done([programme("A")]);
        assert.equal(f.service.peek(f.ref()), null);
        assert.equal(f.service.snapshot(f.ref()).current.id, "A");
        f.advance(110);
        f.flush();
        assert.equal(f.requests.length, 2);
        f.flush();
        assert.equal(f.requests.length, 2);
    }
);
check(
    "warm invalidation transfers callbacks while preserving their cancellation handles",
    () => {
        const f = fixture(),
            got = [];
        const cancel = f.service.request(f.ref(), () => got.push("cancelled"));
        f.service.request(f.ref(), () => got.push("kept"));
        f.flush();
        f.service.invalidate(true);
        cancel();
        f.flush();
        assert.equal(f.requests.length, 2);
        f.requests[0].done([programme("stale")]);
        f.requests[1].done([programme("fresh")]);
        assert.deepEqual(got, ["kept"]);
    }
);
check("provider replacement drops callbacks and all scheduled work", () => {
    const f = fixture(),
        got = [];
    f.service.request(f.ref(), () => got.push("old"));
    f.flush();
    f.service.invalidate(false);
    f.requests[0].done([programme("stale")]);
    f.flush();
    assert.deepEqual(got, []);
    assert.equal(f.timers.size, 0);
});
check("cancel reentry cannot overwrite a newer channel revision", () => {
    const f = fixture(),
        got = [];
    f.service.request(f.ref(), () => got.push("A"));
    f.flush();
    f.requests[0].onCancel = () => {
        f.tokens[1] = {};
        f.service.request(f.ref(), () => got.push("C"));
    };
    f.tokens[1] = {};
    f.service.request(f.ref(), () => got.push("B"));
    f.flush();
    f.requests[1].done([programme("C")]);
    assert.deepEqual(got, ["C"]);
});
check("a failing UI callback cannot starve the next channel request", () => {
    const f = fixture(),
        got = [];
    f.service.request(f.ref(), () => {
        throw Error("detached UI");
    });
    f.service.request(f.ref(2), () => got.push("two"));
    f.flush();
    f.requests[0].done([programme("one")]);
    f.flush();
    f.requests[1].done([programme("two")]);
    assert.deepEqual(got, ["two"]);
});
check(
    "a retired row completion releases the next channel without decoding",
    () => {
        const f = fixture(),
            got = [],
            retired = programme("retired");
        let decoded = 0;
        Object.defineProperty(retired, "title", {
            enumerable: true,
            get() {
                decoded++;
                return "retired";
            },
        });
        const old = f.ref();
        f.service.request(old, () => got.push("retired"));
        f.service.request(f.ref(2), () => got.push("two"));
        f.flush();
        f.tokens[1] = {};
        f.requests[0].done([retired]);
        f.flush();
        assert.equal(decoded, 0, "a retired response never reaches the codec");
        assert.equal(
            f.requests.length,
            2,
            "the other channel starts immediately"
        );
        assert.equal(f.requests[1].ref.id, 2);
        assert.equal(f.service.snapshot(old), null);
        assert.equal(f.service.snapshot(f.ref()), null);
        assert.equal(f.service.peek(f.ref()), null);
        f.requests[1].done([programme("two")]);
        assert.deepEqual(got, ["two"]);
    }
);
check(
    "late retired completions cannot release a replacement transport slot",
    () => {
        for (const completeBeforeReplacement of [false, true]) {
            const f = fixture(),
                got = [];
            f.service.request(f.ref(), () => got.push("retired"));
            f.flush();
            f.tokens[1] = {};
            if (completeBeforeReplacement)
                f.requests[0].done([programme("retired")]);
            f.service.request(f.ref(), () => got.push("replacement"));
            f.service.request(f.ref(2), () => got.push("two"));
            f.flush();
            assert.equal(f.requests.length, 2);
            assert.equal(f.requests[1].ref.id, 1);
            f.requests[0].done([programme("late or duplicate")]);
            f.flush();
            assert.equal(
                f.requests.length,
                2,
                "replacement still owns the serial slot"
            );
            assert.equal(f.requests[1].canceled, 0);
            f.requests[1].done([programme("replacement")]);
            f.flush();
            assert.equal(f.requests.length, 3);
            assert.equal(f.service.peek(f.ref())[0].title, "replacement");
            f.requests[2].done([programme("two")]);
            assert.deepEqual(got, ["replacement", "two"]);
        }
    }
);
check(
    "synchronous row invalidation during decoding cannot starve the queue",
    () => {
        const f = fixture(),
            got = [],
            retired = programme("retired");
        Object.defineProperty(retired, "title", {
            enumerable: true,
            get() {
                f.tokens[1] = {};
                return "retired";
            },
        });
        f.service.request(f.ref(), () => got.push("retired"));
        f.service.request(f.ref(2), () => got.push("two"));
        f.flush();
        f.requests[0].done([retired]);
        f.flush();
        assert.equal(f.requests.length, 2);
        assert.equal(f.requests[1].ref.id, 2);
        assert.equal(f.service.snapshot(f.ref()), null);
        assert.equal(f.service.peek(f.ref()), null);
        f.requests[1].done([programme("two")]);
        assert.deepEqual(got, ["two"]);
    }
);
check(
    "warm refresh subscriptions cancel their new fetch when the last observer leaves",
    () => {
        const f = fixture();
        const cancel = f.service.subscribe(f.ref(), () => {});
        f.flush();
        f.service.invalidate(true);
        f.flush();
        assert.equal(f.requests.length, 2);
        cancel();
        assert.equal(f.requests[1].canceled, 1);
    }
);

const T = 1700000000;
const clockRows = [
    programme("Programme A", T, T + 60),
    programme("Programme B", T + 60, T + 120),
    programme("Programme C", T + 120, T + 180),
];
function establishClock() {
    const f = fixture(8, { independentClock: true });
    f.setEpoch(T + 90);
    f.service.subscribe(f.ref(), () => {});
    f.advanceElapsed(0);
    assert.equal(f.requests.length, 1);
    f.requests[0].done(clockRows.map((row) => ({ ...row })));
    assert.equal(f.service.snapshot(f.ref()).current.title, "Programme B");
    assert.equal(f.requests.length, 1);
    return f;
}
check(
    "field reads realign after clock jumps before any timer or snapshot",
    () => {
        for (const [epoch, title, start, end] of [
            [T + 30, "Programme A", T, T + 60],
            [T + 120, "Programme C", T + 120, T + 180],
        ]) {
            const f = establishClock();
            const callbackTitles = [];
            let notifications = 0;
            f.service.subscribe(f.ref(), () => {
                notifications++;
                callbackTitles.push(f.service.field(f.ref(), "title"));
            });
            f.setEpoch(epoch);
            assert.equal(f.service.field(f.ref(), "title"), title);
            assert.equal(f.service.field(f.ref(), "start"), start);
            assert.equal(f.service.field(f.ref(), "end"), end);
            assert.equal(f.service.field(f.ref(), "missing"), false);
            assert.equal(notifications, 1);
            const ids = [...f.timers.keys()];
            for (let step = 1; step <= 10; step++) {
                f.setEpoch(epoch + step / 1000);
                assert.equal(f.service.field(f.ref(), "title"), title);
            }
            assert.equal(notifications, 1);
            assert.deepEqual(callbackTitles, [title]);
            assert.deepEqual([...f.timers.keys()], ids);
            assert.equal(f.requests.length, 1);
        }
    }
);
check(
    "backward epoch reselects the retained current programme without another request",
    () => {
        const f = establishClock();
        f.setEpoch(T);
        f.advanceElapsed(30000);
        assert.equal(f.epoch(), T + 30);
        assert.equal(f.elapsed(), 30000);
        const snapshot = f.service.snapshot(f.ref());
        assert.equal(snapshot.current.title, "Programme A");
        assert.equal(snapshot.current.start, T);
        assert.equal(snapshot.current.end, T + 60);
        assert.equal(snapshot.following[0].title, "Programme B");
        assert.equal(snapshot.following[0].start, T + 60);
        assert.equal(f.requests.length, 1);
        snapshot.current.title = "mutated";
        assert.equal(f.service.snapshot(f.ref()).current.title, "Programme A");
    }
);
check(
    "forward elapsed clock keeps the half-open current programme and one request",
    () => {
        const f = establishClock();
        f.advanceElapsed(30000);
        assert.equal(f.epoch(), T + 120);
        const snapshot = f.service.snapshot(f.ref());
        assert.equal(snapshot.current.title, "Programme C");
        assert.equal(snapshot.current.start, T + 120);
        assert.equal(f.requests.length, 1);
    }
);
check("a retired service timer cannot request after source replacement", () => {
    const f = establishClock();
    const retired = [...f.timers.values()];
    assert.equal(
        retired.some((timer) => timer.delay === 30000),
        true
    );
    f.source("two");
    f.service.invalidate(false);
    for (const timer of retired) timer.fn();
    f.advanceElapsed(0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.service.snapshot(f.ref()), null);
});

function timerIds(f) {
    return [...f.timers.keys()].sort((a, b) => a - b);
}
check(
    "distant future rows keep forward snapshots from moving retry or listeners",
    () => {
        const f = fixture(8, { independentClock: true });
        const origin = T + 90.004;
        f.setEpoch(origin);
        let notifications = 0;
        f.service.subscribe(f.ref(), () => {
            notifications++;
        });
        f.advanceElapsed(0);
        f.requests[0].done([programme("Later", T + 10000, T + 10100)]);
        const settled = notifications;
        const first = f.service.snapshot(f.ref());
        assert.equal(first.current, null);
        assert.equal(first.following[0].title, "Later");
        assert.equal(first.following[0].start, T + 10000);
        assert.ok(Math.abs(first.retryAt - (origin + 3600)) < 0.01);
        const ids = timerIds(f);
        for (let step = 1; step <= 10; step++) {
            f.setEpoch(origin + step / 1000);
            const next = f.service.snapshot(f.ref());
            assert.equal(next.current, null);
            assert.equal(next.retryAt, first.retryAt);
        }
        assert.equal(notifications, settled);
        assert.deepEqual(timerIds(f), ids);
        assert.equal(f.requests.length, 1);
    }
);
check(
    "a nearer future row keeps its fixed retry deadline across forward reads",
    () => {
        const f = fixture(8, { independentClock: true });
        const origin = T + 90.004;
        f.setEpoch(origin);
        let notifications = 0;
        f.service.subscribe(f.ref(), () => {
            notifications++;
        });
        f.advanceElapsed(0);
        f.requests[0].done([programme("Soon", T + 1000, T + 1100)]);
        const settled = notifications;
        const first = f.service.snapshot(f.ref());
        assert.equal(first.current, null);
        assert.equal(first.retryAt, T + 1000);
        const ids = timerIds(f);
        for (let step = 1; step <= 10; step++) {
            f.setEpoch(origin + step / 1000);
            assert.equal(f.service.snapshot(f.ref()).retryAt, T + 1000);
        }
        assert.equal(notifications, settled);
        assert.deepEqual(timerIds(f), ids);
        assert.equal(f.requests.length, 1);
        f.advanceElapsed((T + 1000 - f.epoch()) * 1000);
        const current = f.service.snapshot(f.ref());
        assert.equal(f.epoch(), T + 1000);
        assert.equal(current.current.title, "Soon");
        assert.equal(current.current.start, T + 1000);
        assert.equal(f.requests.length, 1);
    }
);

check("projection records the same epoch used to select its programme", () => {
    let rollback = true;
    const f = fixture(8, {
        afterSelect() {
            if (rollback) {
                rollback = false;
                f.setEpoch(T + 30);
            }
        },
        independentClock: true,
    });
    f.setEpoch(T + 90);
    f.service.seed(
        f.ref(),
        clockRows.map((row) => ({ ...row }))
    );
    assert.equal(f.epoch(), T + 30);
    const snapshot = f.service.snapshot(f.ref());
    assert.equal(snapshot.current.title, "Programme A");
    assert.equal(snapshot.current.start, T);
    assert.equal(snapshot.following[0].title, "Programme B");
    assert.equal(f.requests.length, 0);
});

console.log(
    "PASS " + passed + " GuideService scenarios with compiled shared core"
);
