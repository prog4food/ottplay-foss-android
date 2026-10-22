const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const test = require("node:test");
const source = ts.transpileModule(
    fs.readFileSync("src/core/standby.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
const context = { exports: {}, Promise };
vm.runInNewContext(source, context);
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, reject, resolve };
}
function fixture(saved = "0") {
    const stored = new Map([["__ottStandbyV1", saved]]),
        requests = [],
        events = [],
        timers = new Map(),
        listeners = new Map();
    let sequence = 0;
    class Xhr {
        constructor() {
            this.listeners = {};
            this.sent = false;
        }
        addEventListener(name, cb) {
            this.listeners[name] = cb;
        }
        send() {
            this.sent = true;
            requests.push(this);
        }
        abort() {
            this.aborted = true;
            this.listeners.loadend?.();
        }
    }
    const w = {
        __ottHostedEpg: {
            suspend() {
                events.push("guide");
            },
        },
        __ottLocalMedia: {
            suspend() {
                events.push("local");
            },
        },
        __ottProviderRuntime: {
            suspend() {
                events.push("provider");
            },
        },
        AbortController,
        addEventListener(type, handler, options) {
            const registered = listeners.get(type) || [];
            registered.push({ handler, options });
            listeners.set(type, registered);
        },
        clearInterval() {},
        clearTimeout(id) {
            timers.delete(id);
        },
        fetch(input, options) {
            const pending = deferred();
            requests.push({ input, options, ...pending });
            return pending.promise;
        },
        setTimeout(fn, delay) {
            timers.set(++sequence, { delay, fn });
            return sequence;
        },
        XMLHttpRequest: Xhr,
    };
    const gate = context.exports.installStandby(
        w,
        (key) => stored.get(key),
        (key, value) => stored.set(key, value)
    );
    return {
        events,
        gate,
        input(type, properties = {}) {
            const event = {
                ...properties,
                preventDefault() {
                    this.prevented = true;
                },
                prevented: false,
                stopImmediatePropagation() {
                    this.stopped = true;
                },
                stopped: false,
                type,
            };
            for (const { handler } of listeners.get(type) || []) {
                handler(event);
                if (event.stopped) break;
            }
            return event;
        },
        listeners,
        requests,
        stored,
        timers,
        w,
    };
}
const tick = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
};
const plain = (value) => JSON.parse(JSON.stringify(value));
test("script downloads remain pending until load and new scripts are blocked", () => {
    const f = fixture(),
        scripts = [];
    const helperSource = fs.readFileSync("src/utils/helpers.ts", "utf8");
    const start = helperSource.indexOf("export function loadScript(");
    const end = helperSource.indexOf("/**", start);
    const helper = {
        alert() {},
        console,
        document: { createElement: () => ({}) },
        window: f.w,
    };
    vm.runInNewContext(
        ts.transpileModule(
            helperSource.slice(start, end).replace("export ", ""),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        helper
    );
    let loaded = 0,
        rejected = 0;
    const host = { appendChild: (script) => scripts.push(script) };
    helper.loadScript(
        "provider.js",
        () => loaded++,
        () => rejected++,
        host
    );
    f.gate.set(true);
    assert.equal(f.gate.snapshot().state, "suspending");
    helper.loadScript(
        "next.js",
        () => loaded++,
        () => rejected++,
        host
    );
    assert.equal(scripts.length, 1);
    assert.equal(rejected, 1);
    scripts[0].onload();
    assert.equal(loaded, 1, "owner callbacks still settle their own lifetime");
    assert.equal(f.gate.snapshot().state, "suspended");
});
test("standby persists before cleanup, blocks new work, invalidates callbacks, and wakes once", () => {
    const f = fixture();
    const generation = f.gate.generation();
    let cancelled = 0,
        starts = 0;
    const release = f.gate.track(() => {
        assert.equal(f.gate.blocked(), true);
        cancelled++;
        release();
    });
    f.gate.set(true);
    assert.equal(f.stored.get("__ottStandbyV1"), "1");
    assert.equal(f.gate.current(generation), false);
    assert.equal(cancelled, 1);
    assert.throws(() => f.gate.track(() => {}), /standby/);
    assert.deepEqual(plain(f.gate.snapshot()), {
        pending: 0,
        state: "suspended",
    });
    f.gate.set(true);
    assert.equal(cancelled, 1);
    f.gate.set(false, () => starts++);
    f.gate.set(false, () => starts++);
    assert.equal(starts, 1);
    assert.equal(f.gate.blocked(), false);
    assert.equal(f.stored.get("__ottStandbyV1"), "0");
});
test("persisted standby is active before any provider or network startup", async () => {
    const f = fixture("1");
    assert.equal(f.gate.isStandby(), true);
    await assert.rejects(f.w.fetch("https://media.test/list"), /standby/);
    assert.throws(() => new f.w.XMLHttpRequest().send(), /standby/);
    assert.equal(f.requests.length, 0);
});
test("native startup probe blocks work until persisted state is known", async () => {
    for (const asleep of [false, true]) {
        const f = fixture(),
            probe = deferred();
        let boots = 0,
            blockedAtBoot;
        f.gate.native(
            async (standby) => ({ pending: 0, quiescent: standby, standby }),
            () => probe.promise
        );
        f.gate.ready(() => {
            boots++;
            blockedAtBoot = f.gate.blocked();
        });
        assert.equal(f.gate.blocked(), true);
        await assert.rejects(f.w.fetch("https://media.test/start"), /standby/);
        assert.equal(boots, 0);
        probe.resolve({ pending: 0, quiescent: asleep, standby: asleep });
        await tick();
        assert.equal(boots, asleep ? 0 : 1);
        if (!asleep) assert.equal(blockedAtBoot, false);
        assert.equal(f.stored.get("__ottStandbyV1"), asleep ? "1" : "0");
    }
});
test("unsupported startup probe permits old shells; failed or timed out probe remains asleep", async () => {
    for (const mode of ["unsupported", "failure", "timeout"]) {
        const f = fixture(),
            probe = deferred();
        let boots = 0;
        f.gate.native(
            async (standby) => ({ pending: 0, quiescent: standby, standby }),
            () => probe.promise
        );
        f.gate.ready(() => boots++);
        if (mode === "timeout")
            [...f.timers.values()].find((t) => t.delay === 10000).fn();
        else
            probe.reject(
                new Error(
                    mode === "unsupported" ? "Command not found" : "IPC failure"
                )
            );
        await tick();
        assert.equal(boots, mode === "unsupported" ? 1 : 0);
        assert.equal(f.gate.blocked(), mode !== "unsupported");
        if (mode === "timeout") {
            probe.resolve({ pending: 0, quiescent: false, standby: false });
            await tick();
            assert.equal(
                f.gate.blocked(),
                true,
                "Late probe cannot wake the player"
            );
        }
    }
});
test("explicit go supersedes a pending boot probe and retires its old startup callback", async () => {
    const f = fixture(),
        probe = deferred(),
        wake = deferred();
    let starts = 0,
        oldBoots = 0;
    f.gate.native(
        () => wake.promise,
        () => probe.promise
    );
    f.gate.ready(() => oldBoots++);
    f.gate.set(false, () => starts++);
    await tick();
    assert.equal(oldBoots, 0);
    wake.resolve({ pending: 0, quiescent: false, standby: false });
    await tick();
    assert.equal(starts, 1);
    assert.equal(f.gate.blocked(), false);
    probe.resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    assert.equal(f.gate.blocked(), false);
    assert.equal(oldBoots, 0);
    assert.equal(f.timers.size, 0);
});
test("fetch bodies are cancelled even after headers; remote transport remains alive", async () => {
    const f = fixture();
    const result = f.w.fetch("https://media.test/guide");
    const body = deferred();
    f.requests[0].resolve({ body: {}, text: () => body.promise });
    const response = await result;
    const text = response.text();
    const control = f.w.fetch({
        __ottRemoteControl: true,
        url: "https://control.test/poll",
    });
    f.gate.set(true);
    assert.equal(f.requests[0].options.signal.aborted, true);
    body.resolve("late guide");
    await assert.rejects(text, /standby/);
    f.requests[1].resolve("remote still alive");
    assert.equal(await control, "remote still alive");
    assert.equal(f.gate.snapshot().pending, 0);
});
test("XHR aborts existing media; command XHR can send while asleep", () => {
    const f = fixture();
    const media = new f.w.XMLHttpRequest();
    media.send();
    f.gate.set(true);
    assert.equal(media.aborted, true);
    const command = new f.w.XMLHttpRequest();
    command.__ottRemoteControl = true;
    command.send();
    assert.equal(command.sent, true);
    assert.equal(f.gate.snapshot().pending, 0);
});
test("native quiescence waits for pending work and late ack cannot override a newer state", async () => {
    const f = fixture();
    const pending = [];
    f.gate.native(
        (standby) => {
            const d = deferred();
            pending.push({ standby, ...d });
            return d.promise;
        },
        () => Promise.resolve({ pending: 0, quiescent: true, standby: true })
    );
    f.gate.set(true);
    await tick();
    assert.deepEqual(plain(f.gate.snapshot()), {
        pending: null,
        state: "suspending",
    });
    pending[0].resolve({ pending: 1, quiescent: false, standby: true });
    await tick();
    assert.deepEqual(plain(f.gate.snapshot()), {
        pending: 1,
        state: "suspending",
    });
    [...f.timers.values()][0].fn();
    await tick();
    assert.deepEqual(plain(f.gate.snapshot()), {
        pending: 0,
        state: "suspended",
    });
    let starts = 0;
    f.gate.set(false, () => starts++);
    await tick();
    assert.equal(f.gate.blocked(), true);
    f.gate.set(true);
    await tick();
    pending[1].resolve({ pending: 0, quiescent: true, standby: false });
    await tick();
    assert.equal(starts, 0);
    assert.equal(f.gate.isStandby(), true);
    pending[2].resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    assert.equal(f.gate.snapshot().state, "suspended");
});
test("old shells report unsupported, retain frontend block, and allow explicit wake", async () => {
    const f = fixture();
    f.gate.native(() => Promise.reject(new Error("command not found")), null);
    f.gate.set(true);
    await tick();
    assert.deepEqual(plain(f.gate.snapshot()), {
        pending: null,
        state: "unsupported",
    });
    let starts = 0;
    f.gate.set(false, () => starts++);
    await tick();
    assert.equal(starts, 1);
    assert.equal(f.gate.isStandby(), false);
});
test("native errors cannot silently launch a partially awake player", async () => {
    const f = fixture();
    f.gate.native(() => Promise.reject(new Error("native failed")), null);
    f.gate.set(true);
    await tick();
    let starts = 0;
    f.gate.set(false, () => starts++);
    await tick();
    assert.equal(starts, 0);
    assert.equal(f.gate.isStandby(), true);
    assert.equal(f.gate.snapshot().state, "error");
    assert.equal(f.stored.get("__ottStandbyV1"), "1");
});
test("repeating standby retries a failed native transition without waking", async () => {
    const f = fixture();
    let calls = 0;
    f.gate.native(
        async (standby) => {
            if (++calls === 1) throw new Error("Temporary IPC failure");
            return { pending: 0, quiescent: standby, standby };
        },
        async () => ({ pending: 0, quiescent: false, standby: false })
    );
    await tick();
    f.gate.set(true);
    await tick();
    assert.equal(f.gate.snapshot().state, "error");
    f.gate.set(true);
    await tick();
    assert.equal(calls, 2);
    assert.equal(f.gate.snapshot().state, "suspended");
    assert.equal(f.gate.isStandby(), true);
});
test("native deadline rejects a late wake without starting playback", async () => {
    const f = fixture("1");
    const pending = deferred();
    f.gate.native(() => pending.promise, null);
    f.gate.set(false, () => assert.fail("late wake must not start"));
    await tick();
    for (const timer of [...f.timers.values()])
        if (timer.delay === 10000) timer.fn();
    await tick();
    assert.equal(f.gate.isStandby(), true);
    assert.equal(f.gate.snapshot().state, "error");
    pending.resolve({ pending: 0, quiescent: true, standby: false });
    await tick();
    assert.equal(f.gate.isStandby(), true);
});
test("stream reader completion releases fetch ownership", async () => {
    const f = fixture();
    const response = f.w.fetch("https://media.test/segments");
    f.requests[0].resolve({
        body: {
            getReader: () => ({
                cancel() {},
                read: () => Promise.resolve({ done: true }),
            }),
        },
    });
    await (await response).body.getReader().read();
    assert.equal(f.gate.snapshot().pending, 0);
});
test("synchronous fetch failure releases ownership", async () => {
    const w = {
        AbortController,
        clearTimeout() {},
        fetch() {
            throw new Error("fetch failed");
        },
    };
    const gate = context.exports.installStandby(
        w,
        () => null,
        () => {}
    );
    await assert.rejects(w.fetch("invalid"), /fetch failed/);
    assert.equal(gate.snapshot().pending, 0);
});
test("legacy fetch blocks new work but does not claim uncancellable requests stopped", async () => {
    const d = deferred();
    const w = { clearTimeout() {}, fetch: () => d.promise };
    const gate = context.exports.installStandby(
        w,
        () => null,
        () => {}
    );
    const first = w.fetch("existing");
    gate.set(true);
    assert.equal(gate.snapshot().state, "unsupported");
    await assert.rejects(w.fetch("new"), /standby/);
    d.resolve({});
    await assert.rejects(first, /standby/);
    assert.equal(gate.snapshot().state, "unsupported");
});
test("native transitions are serial and retain each captured target", async () => {
    const f = fixture();
    const calls = [];
    f.gate.native((standby) => {
        const d = deferred();
        calls.push({ standby, ...d });
        return d.promise;
    }, null);
    f.gate.set(true);
    f.gate.set(false, () => assert.fail("superseded wake"));
    f.gate.set(true);
    await tick();
    assert.deepEqual(
        calls.map((x) => x.standby),
        [true]
    );
    calls[0].resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    assert.deepEqual(
        calls.map((x) => x.standby),
        [true, false]
    );
    calls[1].resolve({ pending: 0, quiescent: true, standby: false });
    await tick();
    assert.deepEqual(
        calls.map((x) => x.standby),
        [true, false, true]
    );
    calls[2].resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    assert.equal(f.gate.snapshot().state, "suspended");
});
test("late timed-out native wake is followed by restoring standby before another go", async () => {
    const f = fixture();
    const calls = [];
    f.gate.native((standby) => {
        const d = deferred();
        calls.push({ standby, ...d });
        return d.promise;
    }, null);
    f.gate.set(true);
    await tick();
    calls[0].resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    f.gate.set(false, () => assert.fail("timed-out wake"));
    await tick();
    const timeout = [...f.timers.values()].find((x) => x.delay === 10000);
    timeout.fn();
    await tick();
    assert.equal(f.gate.isStandby(), true);
    assert.equal(f.gate.snapshot().state, "error");
    calls[1].resolve({ pending: 0, quiescent: true, standby: false });
    await tick();
    assert.deepEqual(
        calls.map((x) => x.standby),
        [true, false, true]
    );
    calls[2].resolve({ pending: 0, quiescent: true, standby: true });
    await tick();
    assert.equal(f.gate.snapshot().state, "suspended");
});
test("wake waits for native teardown to drain before starting a new decoder", async () => {
    const f = fixture("1");
    let remaining = 1,
        starts = 0;
    f.gate.native(
        (standby) =>
            Promise.resolve({ pending: remaining, quiescent: false, standby }),
        () =>
            Promise.resolve({
                pending: remaining,
                quiescent: false,
                standby: false,
            })
    );
    f.gate.set(false, () => starts++);
    await tick();
    assert.equal(starts, 0);
    assert.equal(f.gate.blocked(), true);
    remaining = 0;
    [...f.timers.values()].find((x) => x.delay === 250).fn();
    await tick();
    assert.equal(starts, 1);
    assert.equal(f.gate.blocked(), false);
});

test("local wake consumes the complete first gesture and preserves later controls", () => {
    for (const [pointerEvents, gesture, next] of [
        [false, ["keydown", "keypress", "keydown", "keyup"], "keydown"],
        [
            true,
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"],
            "pointerdown",
        ],
        [
            false,
            ["touchstart", "touchend", "mousedown", "mouseup", "click"],
            "touchstart",
        ],
        [
            true,
            ["pointerdown", "touchstart", "pointerup", "touchend"],
            "pointerdown",
        ],
        [false, ["touchstart", "touchend"], "touchstart"],
        [false, ["mousedown", "mouseup"], "mousedown"],
        [false, ["click"], "click"],
    ]) {
        const f = fixture();
        if (pointerEvents) f.w.PointerEvent = function () {};
        const locked = { locked: () => true };
        f.w.__ottKiosk = locked;
        let starts = 0;
        let wakes = 0;
        f.w.stbSetStandby = (value) => {
            assert.equal(value, false);
            wakes++;
            f.gate.set(value, () => starts++);
        };
        f.gate.set(true);
        for (const type of gesture) {
            const event = f.input(type, { isTrusted: false });
            assert.equal(
                event.prevented,
                true,
                type + " cannot leak into player controls"
            );
            assert.equal(event.stopped, true);
            assert.equal(f.listeners.get(type)[0].options.capture, true);
            assert.equal(f.listeners.get(type)[0].options.passive, false);
        }
        assert.equal(wakes, 1);
        assert.equal(starts, 1);
        assert.equal(f.gate.blocked(), false);
        assert.equal(
            f.input(next).prevented,
            false,
            "the next deliberate gesture reaches controls"
        );
        assert.strictEqual(
            f.w.__ottKiosk,
            locked,
            "waking does not remove kiosk constraints"
        );
    }
});

test("motion, hover and focus do not wake a player left in standby", () => {
    const f = fixture("1");
    let wakes = 0;
    f.w.stbSetStandby = () => wakes++;
    for (const type of [
        "mousemove",
        "pointermove",
        "mouseover",
        "focus",
        "wheel",
    ]) {
        assert.equal(f.input(type).prevented, false);
    }
    assert.equal(wakes, 0);
    assert.equal(f.gate.blocked(), true);
});

test("local gesture keeps native wake admission blocked until acknowledgement", async () => {
    const f = fixture();
    const wake = deferred();
    const requests = [];
    let starts = 0;
    f.w.PointerEvent = function () {};
    f.gate.native((standby) => {
        requests.push(standby);
        return standby
            ? Promise.resolve({ pending: 0, quiescent: true, standby: true })
            : wake.promise;
    });
    f.w.stbSetStandby = (value) => f.gate.set(value, () => starts++);
    f.gate.set(true);
    await tick();
    assert.equal(f.input("pointerdown").prevented, true);
    await tick();
    assert.equal(starts, 0);
    assert.equal(f.gate.blocked(), true);
    assert.equal(f.input("keydown").prevented, true);
    assert.equal(f.input("pointerup").prevented, true);
    assert.deepEqual(
        requests,
        [true, false],
        "additional input does not issue another native wake"
    );
    wake.resolve({ pending: 0, quiescent: false, standby: false });
    await tick();
    assert.equal(starts, 1);
    assert.equal(f.gate.blocked(), false);
    assert.equal(
        f.input("click").prevented,
        true,
        "trailing click cannot activate a control"
    );
    assert.equal(f.input("keyup").prevented, true);
    assert.equal(f.input("pointerdown").prevented, false);
    assert.equal(f.input("keydown").prevented, false);
});

test("a key held before standby cannot wake it by autorepeat", () => {
    const f = fixture();
    let wakes = 0;
    f.w.stbSetStandby = (value) => {
        wakes++;
        f.gate.set(value);
    };
    assert.equal(f.input("keydown").prevented, false);
    f.gate.set(true);
    assert.equal(f.input("keydown", { repeat: true }).prevented, true);
    assert.equal(wakes, 0);
    assert.equal(f.gate.blocked(), true);
    assert.equal(f.input("keyup").prevented, true);
    assert.equal(f.input("keydown", { repeat: false }).prevented, true);
    assert.equal(wakes, 1, "a fresh press wakes normally");
    assert.equal(f.gate.blocked(), false);
});

test("legacy native _doKey wakes before channel or volume dispatch", () => {
    const f = fixture();
    const forwarded = [];
    const ast = ts.createSourceFile(
        "key-handler.ts",
        fs.readFileSync("src/key-handler/index.ts", "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const declaration = ast.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === "dispatchKey"
    );
    assert.ok(declaration);
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(declaration.getText(ast), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText,
        {
            exports: module.exports,
            keyHandler: (event) => forwarded.push(event.keyCode),
            window: f.w,
        }
    );
    let wakes = 0;
    f.w.stbSetStandby = (value) => {
        wakes++;
        f.gate.set(value);
    };
    f.gate.set(true);
    module.exports.dispatchKey(40);
    assert.equal(wakes, 1);
    assert.deepEqual(
        forwarded,
        [],
        "first native key cannot advance the channel"
    );
    module.exports.dispatchKey(40);
    assert.deepEqual(
        forwarded,
        [40],
        "later deliberate native keys retain normal dispatch"
    );
});
