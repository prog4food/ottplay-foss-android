const assert = require("node:assert/strict");
const vm = require("node:vm");
const runtime = require("./helpers/private-runtime.cjs");
function fixture() {
    let now = 100,
        next = 0,
        active = true,
        blocked = false,
        available = true;
    const saved = new Map(),
        timers = new Map(),
        prompts = [],
        played = [],
        notified = [];
    const host = {};
    host.window = host;
    vm.createContext(host);
    require("./helpers/shared-core-runtime.cjs")(host);
    runtime(host, "src/guide/reminders.ts");
    const service = host.__ottReminderService.create({
        clearTimer: (id) => timers.delete(id),
        current: () => active,
        leadSeconds: () => 60,
        legacy: () => JSON.parse(saved.get("epgTimers") || "[]"),
        legacyRecord: (row) => row,
        notify: (record, minutes) => notified.push([record, minutes]),
        now: () => now,
        play: (record) => played.push(record),
        prompt(record, accept) {
            const p = { accept, closed: 0, record };
            prompts.push(p);
            return () => p.closed++;
        },
        read: (key) => saved.get(key) ?? null,
        resolve: () => available,
        sourceId: "source",
        timer(fn, delay) {
            const id = ++next;
            timers.set(id, { at: now + delay / 1000, fn });
            return id;
        },
        write(key, value) {
            if (!blocked) saved.set(key, value);
        },
    });
    function record(id = "one", start = 200, end = 300) {
        const programmeId = host.OttPlayCore.guideProgrammeId(
            "source",
            "channel:stable",
            id,
            start
        );
        return {
            channelId: "channel:stable",
            end,
            id: programmeId,
            programmeId,
            sourceId: "source",
            start,
            title: "Programme " + id,
        };
    }
    return {
        advance(value) {
            now = value;
        },
        block() {
            blocked = true;
        },
        flush() {
            for (let i = 0; i < 100; i++) {
                const due = [...timers]
                    .filter(([, t]) => t.at <= now)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) return;
                timers.delete(due[0]);
                due[1].fn();
            }
            throw Error("unbounded reminder loop");
        },
        missing(value) {
            available = !value;
        },
        notified,
        played,
        prompts,
        record,
        saved,
        service,
        sourceChanged() {
            active = false;
        },
        timers,
    };
}
let passed = 0;
function check(name, run) {
    run();
    passed++;
    console.log("PASS reminders: " + name);
}
check(
    "durable record excludes positions/handles; lead and start callbacks fire once",
    () => {
        const f = fixture(),
            record = f.record();
        assert(f.service.upsert(record));
        const doc = JSON.parse(f.saved.get("guideReminders:source"));
        assert.equal(doc.records[0].channelId, "channel:stable");
        assert.equal("c" in doc.records[0], false);
        assert.equal("ti" in doc.records[0], false);
        f.advance(140);
        f.flush();
        assert.equal(f.notified.length, 1);
        assert.equal(f.notified[0][1], 1);
        f.advance(200);
        f.flush();
        assert.equal(f.prompts.length, 1);
        f.prompts[0].accept();
        f.prompts[0].accept();
        assert.equal(f.played.length, 1);
        f.flush();
        assert.equal(f.prompts.length, 1);
    }
);
check("a removed or source-retired confirmation cannot play", () => {
    const f = fixture(),
        record = f.record();
    f.service.upsert(record);
    f.advance(200);
    f.flush();
    assert(f.service.remove(record.id));
    f.prompts[0].accept();
    assert.equal(f.played.length, 0);
    assert.equal(f.prompts[0].closed, 1);
    const g = fixture();
    g.service.upsert(g.record());
    g.advance(200);
    g.flush();
    g.sourceChanged();
    g.prompts[0].accept();
    assert.equal(g.played.length, 0);
});
check(
    "confirmation expires and missing channels never target a neighboring row",
    () => {
        const f = fixture();
        f.service.upsert(f.record());
        f.advance(200);
        f.flush();
        f.advance(300);
        f.prompts[0].accept();
        assert.equal(f.played.length, 0);
        const g = fixture();
        g.missing(true);
        g.service.upsert(g.record());
        g.advance(200);
        g.flush();
        assert.equal(g.prompts.length, 0);
    }
);
check("storage rejection keeps the accepted reminder and pending timer", () => {
    const f = fixture();
    const first = f.record();
    f.service.upsert(first);
    f.block();
    assert.equal(f.service.upsert(f.record("second")), false);
    assert.deepEqual(
        Array.from(f.service.snapshot(), (r) => r.id),
        [first.id]
    );
    f.advance(200);
    f.flush();
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].record.id, first.id);
});
check(
    "future/wrong-source/malformed envelopes stay read-only and untouched",
    () => {
        for (const value of [
            '{"version":999}',
            '{"version":1,"sourceId":"other","records":[]}',
            "{bad",
        ]) {
            const f = fixture();
            f.saved.set("guideReminders:source", value);
            f.service.load();
            assert(f.service.readonly());
            assert.equal(f.service.upsert(f.record()), false);
            assert.equal(f.saved.get("guideReminders:source"), value);
        }
    }
);
check("legacy import retains bytes and claims only its provider scope", () => {
    const f = fixture(),
        record = f.record();
    const old = JSON.stringify([record]);
    f.saved.set("epgTimers", old);
    f.service.load();
    assert.equal(f.service.snapshot().length, 1);
    assert(f.service.persist());
    assert.equal(f.saved.get("epgTimers"), old);
    assert.equal(f.saved.get("guideReminderSource"), "source");
    const g = fixture();
    g.saved.set("epgTimers", JSON.stringify([g.record()]));
    g.saved.set("guideReminderSource", "foreign");
    g.service.load();
    assert.equal(g.service.snapshot().length, 0);
});
check("cold reload does not re-prompt already started programmes", () => {
    const f = fixture();
    f.service.upsert(f.record());
    f.advance(201);
    f.service.load();
    f.flush();
    assert.equal(f.prompts.length, 0);
});
check(
    "programme metadata corrections preserve ID; start corrections reschedule",
    () => {
        const f = fixture(),
            record = f.record();
        f.service.upsert(record);
        record.title = "Corrected";
        record.end = 350;
        f.service.upsert(record);
        assert.equal(f.service.snapshot().length, 1);
        assert.equal(f.service.snapshot()[0].title, "Corrected");
        f.advance(200);
        f.flush();
        record.start = 400;
        record.end = 500;
        assert(f.service.upsert(record));
        assert.equal(f.prompts[0].closed, 1);
        f.prompts[0].accept();
        assert.equal(f.played.length, 0);
        f.advance(400);
        f.flush();
        assert.equal(f.prompts.length, 2);
    }
);
check("disposing revokes timers and outstanding prompt ownership", () => {
    const f = fixture();
    f.service.upsert(f.record());
    f.advance(200);
    f.flush();
    f.service.dispose();
    assert.equal(f.timers.size, 0);
    f.prompts[0].accept();
    assert.equal(f.played.length, 0);
});
check(
    "metadata saves retain notification state for prototype-like programme IDs",
    () => {
        const f = fixture();
        const records = ["__proto__", "constructor", "toString"].map((id) => ({
            ...f.record(id),
            id,
            programmeId: id,
        }));
        f.saved.set(
            "guideReminders:source",
            JSON.stringify({ records, sourceId: "source", version: 1 })
        );
        f.service.load();
        f.advance(140);
        f.flush();
        assert.equal(f.notified.length, 3);
        assert(f.service.persist());
        f.flush();
        assert.equal(
            f.notified.length,
            3,
            "unchanged starts do not notify again"
        );
        f.advance(150);
        assert(f.service.upsert({ ...records[1], start: 210, title: "Moved" }));
        f.flush();
        assert.equal(f.notified.length, 4);
        assert.equal(f.notified[3][0].id, "constructor");
        f.advance(200);
        f.flush();
        assert.deepEqual(
            f.prompts.map((p) => p.record.id),
            ["__proto__", "toString"]
        );
        f.advance(210);
        f.flush();
        assert.equal(f.prompts.at(-1).record.id, "constructor");
    }
);
console.log("PASS " + passed + " ReminderService scenarios");
