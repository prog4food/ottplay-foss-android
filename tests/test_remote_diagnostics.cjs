const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function load(name, dependencies = {}) {
    const module = { exports: {} };
    const source = ts.transpileModule(
        fs.readFileSync(path.join(root, name), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    vm.runInNewContext(
        source,
        {
            console,
            exports: module.exports,
            module,
            require(name) {
                assert(
                    Object.prototype.hasOwnProperty.call(dependencies, name),
                    "unexpected import " + name
                );
                return dependencies[name];
            },
            URL,
        },
        { filename: name }
    );
    return module.exports;
}
const buffer = load("src/plugins/diagnostic-buffer.ts");
const wire = load("src/shared/wire-contracts.ts");
const { createRemoteDiagnostics } = load("src/plugins/remote-diagnostics.ts", {
    "../shared/wire-contracts": wire,
    "./diagnostic-buffer": buffer,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const deviceToken = "DEVICE_FIXTURE_TOKEN_".repeat(3);
const runtimeToken = "RUNTIME_FIXTURE_TOKEN_".repeat(3);
const secret = "NEVER_UPLOAD_THIS_SECRET";
const envelope = (data, epoch = "server-one") => ({
    diagnostics_protocol: 2,
    server_epoch: epoch,
    ...data,
});
const config = (overrides = {}) => ({
    address:
        "https://control.invalid/prefix/api/webhook/commands?device_id=sample",
    bootId: "boot-one",
    consentEpoch: "grant-one",
    enabled: true,
    instanceId: "instance-one",
    token: deviceToken,
    ...overrides,
});

function fakeClock() {
    let now = 10000;
    let next = 1;
    const timers = new Map();
    return {
        advance(duration) {
            const end = now + duration;
            for (let count = 0; ; count++) {
                assert(count < 100000, "timer loop must yield");
                const nextTimer = [...timers]
                    .filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
                if (!nextTimer) break;
                const [id, timer] = nextTimer;
                now = timer.at;
                timers.delete(id);
                timer.callback();
            }
            now = end;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        jump(value) {
            now = value;
        },
        now: () => now,
        setTimeout(callback, delay) {
            const id = next++;
            timers.set(id, { at: now + delay, callback });
            return id;
        },
        timers,
    };
}

function fixture(overrides = {}) {
    const clock = fakeClock();
    const calls = [];
    const captures = [];
    const statuses = [];
    const value = {
        available: true,
        counters: {
            dropped: 1,
            errors: 2,
            recoveries: 3,
            stalls: 4,
            url: secret,
            waiting: 5,
        },
        enabled: true,
        private: secret,
        video: {
            bufferAhead: 6,
            currentTime: 12,
            droppedFrames: 0,
            ended: false,
            errorCode: 2,
            networkState: 2,
            paused: false,
            readyState: 3,
            src: "https://provider.invalid/" + secret,
            videoHeight: 1080,
            videoWidth: 1920,
        },
    };
    const options = {
        capture(event, stopped) {
            const capture = { event, releases: 0, stopped };
            captures.push(capture);
            return () => capture.releases++;
        },
        clearTimeout: clock.clearTimeout,
        now: clock.now,
        onStatus: (status) => statuses.push(plain(status)),
        send(request, callback) {
            const call = {
                answered: false,
                callback,
                cancelled: false,
                request,
            };
            calls.push(call);
            return () => {
                call.cancelled = true;
            };
        },
        setTimeout: clock.setTimeout,
        snapshot: () => value,
        ...overrides,
    };
    const client = createRemoteDiagnostics(options);
    return {
        calls,
        captures,
        client,
        clock,
        close() {
            client.stop();
        },
        pending(route) {
            return calls.find(
                (call) =>
                    call.request.url.endsWith("/api/v2/diagnostics" + route) &&
                    !call.answered &&
                    !call.cancelled
            );
        },
        reply(call, data, status = 200) {
            assert(call, "expected a pending request");
            call.answered = true;
            call.callback({
                body: typeof data === "string" ? data : JSON.stringify(data),
                status,
            });
        },
        statuses,
        value,
    };
}
function registration(runtime = "runtime-one", credential = runtimeToken) {
    return envelope({
        device_id: "configured-device",
        limits: {
            event_bytes_max: 1024,
            events_body_bytes: 16384,
            events_per_batch: 32,
            poll_after_ms: 3000,
            session_lease_ms_max: 600000,
        },
        runtime_credential: credential,
        runtime_id: runtime,
        runtime_ttl_ms: 600000,
    });
}
function registered(
    f,
    options,
    runtime = "runtime-one",
    credential = runtimeToken
) {
    f.client.configure(config(options));
    const request = f.pending("/runtimes");
    assert.equal(
        request.request.headers.Authorization,
        "Bearer " + deviceToken
    );
    f.reply(request, registration(runtime, credential), 201);
    f.clock.advance(0);
    return f.pending("/poll");
}
function control(overrides = {}) {
    return {
        action: "start",
        consent_epoch: "grant-one",
        lease_ms: 60000,
        profile: "standard",
        request_id: "request-one",
        session_id: "session-one",
        ...overrides,
    };
}
function pollReply(
    f,
    value = control(),
    revision = 1,
    runtime = "runtime-one"
) {
    f.reply(
        f.pending("/poll"),
        envelope({
            control: value,
            control_revision: revision,
            poll_after_ms: value ? 1000 : 3000,
            runtime_id: runtime,
        })
    );
}
function start(f, lease = 60000, acknowledge = true) {
    registered(f);
    pollReply(f, control({ lease_ms: lease }));
    assert.equal(f.client.snapshot().state, "active");
    if (acknowledge) acknowledgeResult(f);
    f.clock.advance(0);
}
function acknowledgeResult(f) {
    const call = f.pending("/results");
    if (call) {
        f.reply(call, envelope({ status: "recorded" }));
        f.clock.advance(0);
    }
}
function acknowledgeEvents(f) {
    const call = f.pending("/events");
    if (!call) return;
    const body = JSON.parse(call.request.body);
    f.reply(
        call,
        envelope({
            accepted_through_seq: body.first_seq + body.events.length - 1,
            dropped_total: 0,
        })
    );
}
function assertStopped(f) {
    assert.equal(f.client.snapshot().enabled, false);
    assert.equal(f.client.snapshot().sessionId, null);
    for (const capture of f.captures) assert.equal(capture.releases, 1);
    const active = f.calls.filter((call) => !call.answered && !call.cancelled);
    assert(
        active.length <= 1,
        "only one bounded revocation request may survive local stop"
    );
    if (active.length) {
        const call = active[0];
        assert(call.request.url.endsWith("/poll"));
        assert.equal(JSON.parse(call.request.body).consent.granted, false);
        assert.equal(call.request.timeoutMs, 1000);
        assert.equal(
            f.clock.timers.size,
            1,
            "only the revocation timeout survives stop"
        );
        f.clock.advance(1000);
    }
    assert.equal(
        f.clock.timers.size,
        0,
        "no timer survives bounded revocation"
    );
    assert(
        !f.calls.some((call) => !call.answered && !call.cancelled),
        "no active request survives bounded revocation"
    );
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("no consent or reliable monotonic clock means no network or capture", () => {
    const f = fixture();
    f.client.configure(config({ enabled: false }));
    assert.equal(f.calls.length, 0);
    assert.equal(f.clock.timers.size, 0);
    f.client.configure(config({ consentEpoch: "" }));
    assert.equal(f.calls.length, 0);
    f.close();
    const unavailable = fixture({ now: () => NaN });
    unavailable.client.configure(config());
    assert.equal(unavailable.calls.length, 0);
    assert.equal(unavailable.client.snapshot().state, "regrant_required");
    unavailable.close();
});

test("each runtime keeps its own registration credential even with one device token", () => {
    const a = fixture();
    const b = fixture();
    try {
        registered(a, {}, "runtime-a", "A".repeat(48));
        registered(b, {}, "runtime-b", "B".repeat(48));
        assert.equal(
            a.calls[0].request.body,
            b.calls[0].request.body,
            "metadata does not identify or merge runtimes"
        );
        assert.equal(
            a.pending("/poll").request.headers.Authorization,
            "Bearer " + "A".repeat(48)
        );
        assert.equal(
            b.pending("/poll").request.headers.Authorization,
            "Bearer " + "B".repeat(48)
        );
        assert.equal(
            JSON.parse(a.pending("/poll").request.body).runtime_id,
            "runtime-a"
        );
        assert.equal(
            JSON.parse(b.pending("/poll").request.body).runtime_id,
            "runtime-b"
        );
        const exposed = JSON.stringify([
            a.client.snapshot(),
            a.statuses,
            b.client.snapshot(),
            b.statuses,
        ]);
        assert(!exposed.includes(deviceToken));
        assert(!exposed.includes("A".repeat(48)));
        assert(!exposed.includes("B".repeat(48)));
        a.client.configure({ ...config(), address: config().address });
        assert.equal(
            a.calls.length,
            2,
            "equivalent config does not re-register"
        );
    } finally {
        a.close();
        b.close();
    }
});

test("control stop bypasses a blocked upload and any unrelated legacy request", () => {
    const f = fixture();
    try {
        const legacy = { stillRunning: true };
        start(f);
        const upload = f.pending("/events");
        assert(upload);
        f.clock.advance(1000);
        pollReply(
            f,
            control({
                action: "stop",
                lease_ms: 0,
                request_id: "request-stop",
            }),
            2
        );
        assert.equal(f.client.snapshot().state, "idle");
        assert.equal(f.captures[0].releases, 1);
        assert.equal(upload.cancelled, true);
        assert.equal(legacy.stillRunning, true);
        const result = JSON.parse(f.pending("/results").request.body);
        assert.equal(result.control_revision, 2);
        assert.equal(result.status, "applied");
        f.reply(
            upload,
            envelope({ accepted_through_seq: 2, dropped_total: 0 })
        );
        assert.equal(f.client.snapshot().sessionId, null);
        assert.equal(f.captures.length, 1);
    } finally {
        f.close();
    }
});

test("start must be acknowledged before upload while stop can supersede pending acknowledgement", () => {
    const f = fixture();
    try {
        start(f, 60000, false);
        const result = f.pending("/results");
        assert(result);
        assert.equal(f.pending("/events"), undefined);
        for (let i = 0; i < 5; i++) {
            f.clock.advance(1000);
            pollReply(f, control());
        }
        const retry = f.pending("/results");
        assert(retry && retry !== result);
        assert.equal(retry.request.body, result.request.body);
        assert.equal(f.pending("/events"), undefined);
        f.clock.advance(1000);
        pollReply(
            f,
            control({
                action: "stop",
                lease_ms: 0,
                request_id: "request-stop",
            }),
            2
        );
        assert.equal(retry.cancelled, true);
        f.reply(result, envelope({ status: "recorded" }));
        f.reply(retry, envelope({ status: "recorded" }));
        f.clock.advance(0);
        assert.equal(f.pending("/events"), undefined);
        assert.equal(f.client.snapshot().sessionId, null);
        assert.equal(f.captures[0].releases, 1);
    } finally {
        f.close();
    }
    const confirmed = fixture();
    try {
        start(confirmed, 60000, false);
        assert.equal(confirmed.pending("/events"), undefined);
        acknowledgeResult(confirmed);
        assert(confirmed.pending("/events"));
    } finally {
        confirmed.close();
    }
});

test("local suspension cancels everything and blocks same-grant replay", () => {
    const f = fixture();
    try {
        start(f);
        f.clock.advance(1000);
        const late = f.pending("/poll");
        f.client.stop("suspended");
        assertStopped(f);
        const before = f.calls.length;
        f.reply(
            late,
            envelope({
                control: control({ request_id: "late-start" }),
                control_revision: 2,
                poll_after_ms: 1000,
                runtime_id: "runtime-one",
            })
        );
        f.client.configure(config());
        f.clock.advance(60000);
        assert.equal(f.calls.length, before);
        assert.equal(f.captures.length, 1);
        assert.equal(f.client.snapshot().state, "regrant_required");
        f.client.configure(config({ consentEpoch: "grant-two" }));
        assert(f.pending("/runtimes"));
    } finally {
        f.close();
    }
});

test("lease starts at issuing poll, duplicate starts never renew it", () => {
    const f = fixture();
    try {
        start(f, 6000);
        acknowledgeResult(f);
        acknowledgeEvents(f);
        for (let i = 0; i < 5; i++) {
            f.clock.advance(1000);
            pollReply(f, control({ lease_ms: 6000 }));
            acknowledgeEvents(f);
        }
        assert.equal(f.captures.length, 1);
        f.clock.advance(1000);
        assert.equal(f.client.snapshot().reason, "lease_expired");
        assertStopped(f);
    } finally {
        f.close();
    }
    const delayed = fixture();
    try {
        registered(delayed);
        delayed.clock.advance(3000);
        pollReply(delayed, control({ lease_ms: 2000 }));
        assert.equal(delayed.captures.length, 0);
        assert.equal(delayed.client.snapshot().reason, "lease_expired");
    } finally {
        delayed.close();
    }
});

test("loss of successful polls expires capture in ten seconds independently", () => {
    const f = fixture();
    try {
        start(f, 600000);
        f.clock.advance(9999);
        assert.equal(f.client.snapshot().state, "active");
        f.clock.advance(1);
        assert.equal(f.client.snapshot().reason, "disconnected");
        assertStopped(f);
    } finally {
        f.close();
    }
});

test("uncertain uploads retry identical bytes and sequence despite new events", () => {
    const f = fixture();
    try {
        start(f);
        acknowledgeResult(f);
        const first = f.pending("/events");
        const body = first.request.body;
        for (let i = 0; i < 5; i++) {
            f.clock.advance(1000);
            pollReply(f, null);
        }
        assert.equal(first.cancelled, true);
        const replay = f.pending("/events");
        assert(replay && replay !== first);
        assert.equal(replay.request.body, body);
        acknowledgeEvents(f);
        f.reply(
            first,
            envelope({ accepted_through_seq: 9999, dropped_total: 0 })
        );
        assert.equal(
            f.client.snapshot().state,
            "active",
            "late old reply cannot replace the current acknowledgement"
        );
        f.clock.advance(1000);
        pollReply(f, null);
        f.clock.advance(1000);
        const next = JSON.parse(f.pending("/events").request.body);
        const sent = JSON.parse(body);
        assert.equal(next.first_seq, sent.first_seq + sent.events.length);
        assert(next.events.length > 0);
    } finally {
        f.close();
    }
});

test("telemetry contains only structural numeric/boolean allowlists", () => {
    const f = fixture();
    try {
        start(f);
        acknowledgeResult(f);
        acknowledgeEvents(f);
        const capture = f.captures[0];
        capture.event({ cat: "sys", data: { password: secret }, msg: secret });
        capture.event({
            cat: "net",
            data: { authorization: secret, status: 503, url: secret },
            msg: "xhr status",
        });
        capture.event({
            cat: "hls",
            data: { loadMs: 20, size: 1234, sn: secret },
            msg: "FRAG_LOADED",
        });
        capture.event({
            cat: "video",
            data: { code: 2, message: secret },
            msg: "error",
        });
        f.value.available = 1;
        f.value.video.paused = 1;
        f.value.video.currentTime = Infinity;
        f.clock.advance(1000);
        pollReply(f, null);
        f.clock.advance(1000);
        const upload = f.pending("/events");
        assert(upload);
        const text = upload.request.body;
        assert(!text.includes(secret));
        assert(!text.includes("provider.invalid"));
        assert(!text.includes("authorization"));
        assert(!text.includes("url"));
        const data = JSON.parse(text);
        assert(data.events.length <= 32);
        assert(Buffer.byteLength(text) <= 16384);
        assert(data.events.some((event) => event.metrics.httpStatus === 503));
        assert(data.events.some((event) => event.metrics.loadedBytes === 1234));
        for (const event of data.events) {
            assert.deepEqual(Object.keys(event).sort(), [
                "code",
                "elapsed_ms",
                "kind",
                "metrics",
            ]);
            assert(Object.keys(event.metrics).length <= 24);
            for (const [key, value] of Object.entries(event.metrics)) {
                assert(["number", "boolean"].includes(typeof value));
                if (["paused", "ended", "available", "enabled"].includes(key))
                    assert.equal(typeof value, "boolean");
            }
        }
        assert.equal(
            data.events
                .filter(
                    (event) =>
                        event.code === "sample" && event.kind === "playback"
                )
                .at(-1).metrics.currentTime,
            undefined
        );
    } finally {
        f.close();
    }
});

test("wrong runtime, duplicate JSON keys and conflicting revisions fail closed", () => {
    for (const variant of ["runtime", "duplicate", "revision", "unknown"]) {
        const f = fixture();
        try {
            registered(f);
            const data = envelope({
                control: control(),
                control_revision: 1,
                poll_after_ms: 1000,
                runtime_id:
                    variant === "runtime" ? "runtime-other" : "runtime-one",
            });
            if (variant === "unknown") data.extra = secret;
            if (variant === "duplicate") {
                f.reply(
                    f.pending("/poll"),
                    JSON.stringify(data).replace(
                        '"control_revision":1',
                        '"control_revision":0,"control_revision":1'
                    )
                );
            } else
                pollReply(
                    f,
                    variant === "revision" ? null : data.control,
                    1,
                    data.runtime_id
                );
            if (variant === "unknown") {
                f.clock.advance(1000);
                f.reply(f.pending("/poll"), data);
            }
            assert.equal(
                f.client.snapshot().state,
                "regrant_required",
                variant
            );
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("server epoch or credential rejection requires a new local grant", () => {
    for (const status of [200, 401, 403, 404]) {
        const f = fixture();
        try {
            start(f);
            f.clock.advance(1000);
            const data =
                status === 200
                    ? envelope(
                          {
                              control: null,
                              control_revision: 1,
                              poll_after_ms: 1000,
                              runtime_id: "runtime-one",
                          },
                          "server-restarted"
                      )
                    : envelope({ error: { code: "not_allowed" } });
            f.reply(f.pending("/poll"), data, status);
            assertStopped(f);
            const before = f.calls.length;
            f.client.configure(config());
            assert.equal(f.calls.length, before);
        } finally {
            f.close();
        }
    }
});

test("stale registration after revoke cannot retain credential or start polling", () => {
    const f = fixture();
    try {
        f.client.configure(config());
        const stale = f.pending("/runtimes");
        f.client.stop("consent_revoked");
        f.reply(stale, registration(), 201);
        f.clock.advance(100000);
        assert.equal(f.calls.length, 1);
        assert.equal(f.captures.length, 0);
        assert.equal(f.client.snapshot().runtimeId, null);
    } finally {
        f.close();
    }
});

test("capture shutdown and monotonic clock regression retire the runtime", () => {
    const f = fixture();
    try {
        start(f);
        f.captures[0].stopped();
        assertStopped(f);
    } finally {
        f.close();
    }
    const backward = fixture();
    try {
        start(backward);
        backward.clock.jump(1);
        backward.captures[0].event({ cat: "video", msg: "playing" });
        assert.equal(backward.client.snapshot().reason, "unsupported");
        assertStopped(backward);
    } finally {
        backward.close();
    }
});

test("saved command endpoints normalize through the shared wire contract", () => {
    for (const endpoint of [
        "",
        wire.wire.commandPath,
        wire.wire.legacyPollPath,
        wire.wire.legacyNotifyPath,
        "/api/v2/diagnostics",
    ]) {
        const f = fixture();
        try {
            f.client.configure(
                config({
                    address:
                        "https://control.invalid/prefix" +
                        endpoint +
                        "/?device_id=sample",
                })
            );
            assert.equal(
                f.pending("/runtimes").request.url,
                "https://control.invalid/prefix/api/v2/diagnostics/runtimes"
            );
        } finally {
            f.close();
        }
    }
    for (const address of [
        "http://control.invalid",
        "https://user:password@control.invalid",
        "https://control.invalid/#fragment",
        "https://control.invalid/?token=" + secret,
    ]) {
        const f = fixture();
        f.client.configure(config({ address }));
        assert.equal(f.calls.length, 0);
        assert.equal(f.client.snapshot().reason, "unsupported");
        f.close();
    }
});

test("local stop sends one bounded consent revocation after immediate capture cleanup", () => {
    const f = fixture();
    start(f);
    const upload = f.pending("/events");
    f.client.stop("local_stop");
    assert.equal(f.captures[0].releases, 1);
    assert(upload.cancelled);
    assert.equal(f.client.snapshot().enabled, false);
    const revoke = f.pending("/poll");
    assert(revoke);
    assert.deepEqual(JSON.parse(revoke.request.body), {
        consent: { granted: false },
        last_control_revision: 1,
        poll_seq: 2,
        runtime_id: "runtime-one",
    });
    assert.equal(
        revoke.request.headers.Authorization,
        "Bearer " + runtimeToken
    );
    assert(!revoke.request.body.includes(deviceToken));
    assert(!revoke.request.url.includes(runtimeToken));
    const count = f.calls.length;
    f.client.stop("local_stop");
    assert.equal(
        f.calls.length,
        count,
        "repeated stops cannot flood revocation"
    );
    assertStopped(f);
    f.reply(
        revoke,
        envelope({
            control: control(),
            control_revision: 99,
            poll_after_ms: 1,
            runtime_id: "runtime-one",
        })
    );
    assert.equal(
        f.captures.length,
        1,
        "revocation response cannot start anything"
    );
    f.close();
});

test("optional input and epg samplers use only canonical metrics and declared capabilities", () => {
    const f = fixture({
        capabilities: ["playback", "network", "input", "epg"],
        epgSnapshot: () => ({
            available: true,
            enabled: true,
            epgEntries: 19,
            epgErrors: 2,
            epgPending: Infinity,
            url: secret,
        }),
        inputSnapshot: () => ({
            available: true,
            cursor: secret,
            enabled: true,
            inputEvents: 7,
            inputListeners: -1,
        }),
    });
    try {
        start(f);
        const text = f.pending("/events").request.body;
        const events = JSON.parse(text).events;
        assert(!text.includes(secret));
        assert.deepEqual(
            events.find((event) => event.kind === "input").metrics,
            { available: true, enabled: true, inputEvents: 7 }
        );
        assert.deepEqual(events.find((event) => event.kind === "epg").metrics, {
            available: true,
            enabled: true,
            epgEntries: 19,
            epgErrors: 2,
        });
    } finally {
        f.close();
    }
    let called = 0;
    const absent = fixture({
        epgSnapshot: () => {
            called++;
        },
        inputSnapshot: () => {
            called++;
        },
    });
    try {
        start(absent);
        assert.equal(called, 0);
    } finally {
        absent.close();
    }
});

test("oversized, nested duplicate and malformed responses cannot trigger capture", () => {
    for (const body of [
        " ".repeat(1024 * 1024),
        JSON.stringify(registration()).replace(
            '"session_lease_ms_max":600000',
            '"session_lease_ms_max":1000,"session_lease_ms_max":600000'
        ),
        JSON.stringify(registration()).replace(
            '"server_epoch":"server-one"',
            '"server_epoch":"server-one","server\\u005fepoch":"server-one"'
        ),
        JSON.stringify(registration()) + "{}",
        "null",
        "[]",
        "{",
        '{"a":[[[[[[[[[[0]]]]]]]]]]}',
    ]) {
        const f = fixture();
        try {
            f.client.configure(config());
            f.reply(f.pending("/runtimes"), body, 201);
            assert.equal(f.captures.length, 0);
            assert.equal(f.client.snapshot().state, "regrant_required");
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("reconfiguration cancels old lanes and stale callbacks cannot affect the new runtime", () => {
    const f = fixture();
    try {
        start(f);
        const upload = f.pending("/events");
        f.clock.advance(1000);
        const oldPoll = f.pending("/poll");
        f.client.configure(config({ consentEpoch: "grant-two" }));
        assert(upload.cancelled && oldPoll.cancelled);
        f.reply(
            upload,
            envelope({ error: { code: "invalid" } }, "server-two"),
            403
        );
        f.reply(
            oldPoll,
            envelope({
                control: control(),
                control_revision: 2,
                poll_after_ms: 1,
                runtime_id: "runtime-one",
            })
        );
        assert.equal(f.client.snapshot().state, "registering");
        const revoke = f.pending("/poll");
        assert.equal(JSON.parse(revoke.request.body).consent.granted, false);
        f.reply(
            revoke,
            envelope({ error: { code: "restarted" } }, "server-old"),
            401
        );
        f.reply(
            f.pending("/runtimes"),
            registration("runtime-two", "N".repeat(48)),
            201
        );
        f.clock.advance(0);
        assert.equal(
            f.pending("/poll").request.headers.Authorization,
            "Bearer " + "N".repeat(48)
        );
        assert.equal(f.captures.length, 1);
    } finally {
        f.close();
    }
});

test("an operator stop racing with results or uploads preserves runtime and receives its own acknowledgement", () => {
    for (const route of ["/results", "/events"]) {
        for (const stopFirst of [false, true]) {
            const f = fixture();
            try {
                start(f, 60000, route === "/events");
                const operation = f.pending(route);
                assert(operation);
                const code =
                    route === "/results" ? "stale_control" : "session_inactive";
                if (!stopFirst) {
                    f.reply(operation, envelope({ error: { code } }), 409);
                    assert.equal(f.client.snapshot().enabled, true);
                    assert.equal(f.client.snapshot().sessionId, null);
                    assert.equal(f.captures[0].releases, 1);
                    f.clock.advance(0);
                } else f.clock.advance(1000);
                pollReply(
                    f,
                    control({
                        action: "stop",
                        lease_ms: 0,
                        request_id: "request-stop",
                    }),
                    2
                );
                const stopResult = f.pending("/results");
                assert.equal(
                    JSON.parse(stopResult.request.body).request_id,
                    "request-stop"
                );
                if (stopFirst)
                    f.reply(operation, envelope({ error: { code } }), 409);
                assert.equal(f.pending("/results"), stopResult);
                acknowledgeResult(f);
                assert.equal(f.client.snapshot().enabled, true);
                assert.equal(f.client.snapshot().state, "idle");
                assert.equal(f.captures[0].releases, 1);
                f.clock.advance(2000);
                assert.equal(
                    f.calls.filter(
                        (call) => call.request.body === operation.request.body
                    ).length,
                    1,
                    "retired operation never retries"
                );
            } finally {
                f.close();
            }
        }
    }
});

test("unrecognized 409 conflicts still fail closed", () => {
    for (const code of [
        "runtime_mismatch",
        "batch_conflict",
        "stale_sequence",
    ]) {
        const f = fixture();
        try {
            start(f);
            f.reply(f.pending("/events"), envelope({ error: { code } }), 409);
            assert.equal(f.client.snapshot().state, "regrant_required");
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("poll and revoke sequence numbers increase even after uncertain control delivery", () => {
    const f = fixture();
    try {
        registered(f);
        const first = f.pending("/poll");
        assert.equal(JSON.parse(first.request.body).poll_seq, 1);
        f.clock.advance(5000);
        const second = f.pending("/poll");
        assert(first.cancelled);
        assert.equal(JSON.parse(second.request.body).poll_seq, 2);
        f.client.stop();
        const revoke = f.pending("/poll");
        assert.equal(JSON.parse(revoke.request.body).poll_seq, 3);
        assert.equal(JSON.parse(revoke.request.body).consent.granted, false);
        f.reply(
            second,
            envelope({
                control: control(),
                control_revision: 1,
                poll_after_ms: 1000,
                runtime_id: "runtime-one",
            })
        );
        assert.equal(f.captures.length, 0);
        assertStopped(f);
    } finally {
        f.close();
    }
});

test("status callbacks may synchronously stop during registration, readiness or capture", () => {
    for (const phase of ["registering", "idle", "active"]) {
        let f;
        f = fixture({
            onStatus: (value) => {
                if (value.state === phase) f.client.stop();
            },
        });
        try {
            f.client.configure(config());
            if (phase !== "registering") {
                f.reply(f.pending("/runtimes"), registration(), 201);
                if (phase === "active") {
                    f.clock.advance(0);
                    pollReply(f);
                }
            }
            assert.equal(f.client.snapshot().enabled, false);
            assert.equal(f.pending("/results"), undefined);
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("registration accepts established 128-character configured device IDs", () => {
    const f = fixture();
    try {
        f.client.configure(config());
        f.reply(
            f.pending("/runtimes"),
            { ...registration(), device_id: "d".repeat(128) },
            201
        );
        f.clock.advance(0);
        assert(f.pending("/poll"));
        assert.equal(f.client.snapshot().state, "idle");
    } finally {
        f.close();
    }
});

test("a dedicated revocation sender runs only after local cleanup and stays bounded", () => {
    let f;
    const revocations = [];
    f = fixture({
        sendRevocation(request, complete) {
            assert.equal(f.client.snapshot().enabled, false);
            assert.equal(f.client.snapshot().sessionId, null);
            assert.equal(f.captures[0].releases, 1);
            assert(!f.calls.some((call) => !call.answered && !call.cancelled));
            const call = { cancelled: false, complete, request };
            revocations.push(call);
            return () => {
                call.cancelled = true;
            };
        },
    });
    try {
        start(f);
        assert.equal(
            revocations.length,
            0,
            "normal requests never use the exceptional lane"
        );
        const normalCount = f.calls.length;
        f.client.stop("suspended");
        assert.equal(
            f.calls.length,
            normalCount,
            "normal grant-checked sender is not used after stop"
        );
        assert.equal(revocations.length, 1);
        const revoke = revocations[0];
        assert.equal(
            revoke.request.url,
            "https://control.invalid/prefix/api/v2/diagnostics/poll"
        );
        assert.deepEqual(JSON.parse(revoke.request.body), {
            consent: { granted: false },
            last_control_revision: 1,
            poll_seq: 2,
            runtime_id: "runtime-one",
        });
        assert.equal(revoke.request.timeoutMs, 1000);
        assert.equal(
            revoke.request.headers.Authorization,
            "Bearer " + runtimeToken
        );
        assert.equal(f.clock.timers.size, 1);
        f.clock.advance(1000);
        assert(revoke.cancelled);
        assert.equal(f.clock.timers.size, 0);
        revoke.complete({
            body: JSON.stringify(envelope({ control: control() })),
            status: 200,
        });
        assert.equal(f.captures.length, 1);
        assert.equal(f.calls.length, normalCount);
    } finally {
        f.close();
    }
});

test("throwing or synchronously completing revocation transports cannot retain work", () => {
    for (const throws of [false, true]) {
        let calls = 0;
        let cancels = 0;
        const f = fixture({
            sendRevocation(_request, complete) {
                calls++;
                if (throws) throw new Error("offline");
                complete({ body: "unavailable", status: 503 });
                return () => {
                    cancels++;
                };
            },
        });
        try {
            start(f);
            f.client.stop();
            assert.equal(calls, 1);
            assert.equal(f.clock.timers.size, 0);
            assert.equal(cancels, throws ? 0 : 1);
            assert.equal(f.captures[0].releases, 1);
            assert.equal(f.client.snapshot().enabled, false);
        } finally {
            f.close();
        }
    }
});

function repairFixture(overrides = {}) {
    const execution = { calls: [], cancelled: 0, effects: 0 };
    const f = fixture({
        executeRepair(action, complete, afterAck) {
            execution.calls.push(action);
            if (action === "reload_player") {
                afterAck(() => {
                    execution.effects++;
                });
                complete("accepted");
            } else {
                execution.effects++;
                complete("applied");
            }
            return () => {
                execution.cancelled++;
            };
        },
        ...overrides,
    });
    f.execution = execution;
    return f;
}
function repairReady(f, runtime = "runtime-one", credential = runtimeToken) {
    registered(f, {}, runtime, credential);
    pollReply(f, null, 0, runtime);
    f.clock.advance(0);
    assert(f.pending("/repairs/poll"));
}
function repairCommand(overrides = {}) {
    return {
        action: "restart_stream",
        consent_epoch: "grant-one",
        lease_ms: 30000,
        repair_id: "repair-one",
        ...overrides,
    };
}
function repairReply(f, repair = repairCommand()) {
    f.reply(f.pending("/repairs/poll"), envelope({ repair }));
}
function repairHeartbeat(
    f,
    milliseconds,
    runtime = "runtime-one",
    revision = 0
) {
    for (let spent = 0; spent < milliseconds; spent += 1000) {
        f.clock.advance(Math.min(1000, milliseconds - spent));
        if (f.pending("/poll")) pollReply(f, null, revision, runtime);
    }
}

test("repairs are advertised only with an executor and target their own runtime without capture", () => {
    const a = repairFixture();
    const b = repairFixture();
    try {
        repairReady(a, "runtime-a", "A".repeat(48));
        repairReady(b, "runtime-b", "B".repeat(48));
        assert(
            JSON.parse(a.calls[0].request.body).capabilities.includes("repairs")
        );
        assert.equal(
            a.pending("/repairs/poll").request.headers.Authorization,
            "Bearer " + "A".repeat(48)
        );
        assert.deepEqual(JSON.parse(a.pending("/repairs/poll").request.body), {
            runtime_id: "runtime-a",
        });
        repairReply(a);
        repairReply(b, null);
        assert.deepEqual(a.execution.calls, ["restart_stream"]);
        assert.equal(a.execution.effects, 1);
        assert.equal(a.captures.length, 0);
        assert.equal(b.execution.effects, 0);
        const result = a.pending("/repairs/results");
        assert.deepEqual(JSON.parse(result.request.body), {
            repair_id: "repair-one",
            runtime_id: "runtime-a",
            status: "applied",
        });
        a.reply(result, envelope({ status: "recorded" }));
        repairHeartbeat(a, 3000, "runtime-a");
        repairReply(a);
        assert.equal(
            a.execution.effects,
            1,
            "retired repair ID is never executed again"
        );
        assert.equal(a.pending("/repairs/results"), undefined);
    } finally {
        a.close();
        b.close();
    }
    const disabled = fixture({ capabilities: ["playback", "repairs"] });
    try {
        registered(disabled);
        assert(
            !JSON.parse(disabled.calls[0].request.body).capabilities.includes(
                "repairs"
            )
        );
        pollReply(disabled, null, 0);
        disabled.clock.advance(0);
        assert.equal(disabled.pending("/repairs/poll"), undefined);
    } finally {
        disabled.close();
    }
});

test("reload runs only after its exact accepted-result acknowledgement while live", () => {
    const f = repairFixture();
    try {
        repairReady(f);
        repairReply(f, repairCommand({ action: "reload_player" }));
        const result = f.pending("/repairs/results");
        assert.equal(JSON.parse(result.request.body).status, "accepted");
        assert.equal(f.execution.effects, 0);
        repairHeartbeat(f, 2000);
        f.reply(result, envelope({ status: "recorded" }));
        assert.equal(f.execution.effects, 1);
        f.reply(result, envelope({ status: "recorded" }));
        assert.equal(f.execution.effects, 1);
        assert.equal(f.execution.cancelled, 1);
    } finally {
        f.close();
    }
});

test("uncertain repair result retries identical bytes without reexecution and expires on original lease", () => {
    const f = repairFixture();
    try {
        repairReady(f);
        repairReply(
            f,
            repairCommand({ action: "reload_player", lease_ms: 6000 })
        );
        const first = f.pending("/repairs/results");
        repairHeartbeat(f, 3000);
        repairReply(
            f,
            repairCommand({ action: "reload_player", lease_ms: 30000 })
        );
        repairHeartbeat(f, 2000);
        const retry = f.pending("/repairs/results");
        assert(first.cancelled && retry && retry !== first);
        assert.equal(retry.request.body, first.request.body);
        assert.equal(f.execution.calls.length, 1);
        repairHeartbeat(f, 1000);
        assert.equal(retry.cancelled, true);
        f.reply(first, envelope({ status: "recorded" }));
        f.reply(retry, envelope({ status: "recorded" }));
        assert.equal(f.execution.effects, 0);
        assert.equal(f.execution.cancelled, 1);
        repairReply(
            f,
            repairCommand({ action: "reload_player", lease_ms: 30000 })
        );
        assert.equal(
            f.execution.calls.length,
            1,
            "expired remembered IDs never run again"
        );
        assert.equal(
            f.client.snapshot().enabled,
            true,
            "one repair expiry does not revoke support"
        );
    } finally {
        f.close();
    }
});

test("local stop and connectivity expiry discard pending reload effects and late callbacks", () => {
    for (const local of [true, false]) {
        const f = repairFixture();
        try {
            repairReady(f);
            repairReply(f, repairCommand({ action: "reload_player" }));
            const result = f.pending("/repairs/results");
            if (local) f.client.stop("suspended");
            else f.clock.advance(10000);
            assert.equal(f.execution.cancelled, 1);
            assert.equal(f.client.snapshot().enabled, false);
            f.reply(result, envelope({ status: "recorded" }));
            assert.equal(f.execution.effects, 0);
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("repair executor callbacks after cancellation cannot submit a result or register an effect", () => {
    let complete;
    let afterAck;
    let cancel = 0;
    let effect = 0;
    const f = repairFixture({
        executeRepair(_action, done, after) {
            complete = done;
            afterAck = after;
            return () => {
                cancel++;
            };
        },
    });
    try {
        repairReady(f);
        repairReply(f, repairCommand({ action: "reload_player" }));
        f.client.stop();
        const before = f.calls.length;
        afterAck(() => {
            effect++;
        });
        complete("accepted");
        assert.equal(f.calls.length, before);
        assert.equal(cancel, 1);
        assert.equal(effect, 0);
        assertStopped(f);
    } finally {
        f.close();
    }
});

test("invalid repair envelopes, actions, scope and lease values fail closed before execution", () => {
    const invalid = [
        repairCommand({ action: "shell" }),
        repairCommand({ consent_epoch: "old-grant" }),
        repairCommand({ lease_ms: 30001 }),
        repairCommand({ lease_ms: -1 }),
        repairCommand({ lease_ms: 1.5 }),
        repairCommand({ runtime_id: "runtime-other" }),
        { action: "restart_stream" },
        [],
    ];
    for (const value of invalid) {
        const f = repairFixture();
        try {
            repairReady(f);
            repairReply(f, value);
            assert.equal(f.execution.calls.length, 0);
            assert.equal(f.client.snapshot().state, "regrant_required");
            assertStopped(f);
        } finally {
            f.close();
        }
    }
    const delayed = repairFixture();
    try {
        repairReady(delayed);
        delayed.clock.advance(2000);
        repairReply(delayed, repairCommand({ lease_ms: 1000 }));
        assert.equal(
            delayed.execution.calls.length,
            0,
            "delivery latency consumes remaining lease"
        );
        assert.equal(delayed.pending("/repairs/results"), undefined);
    } finally {
        delayed.close();
    }
});

test("terminal repair conflicts retire intent while conflicting receipts fail closed", () => {
    for (const code of ["repair_terminal", "result_conflict"]) {
        const f = repairFixture();
        try {
            repairReady(f);
            repairReply(f, repairCommand({ action: "reload_player" }));
            f.reply(
                f.pending("/repairs/results"),
                envelope({ error: { code } }),
                409
            );
            assert.equal(f.execution.effects, 0);
            assert.equal(f.execution.cancelled, 1);
            assert.equal(
                f.client.snapshot().enabled,
                code === "repair_terminal"
            );
            assert.equal(f.pending("/repairs/results"), undefined);
        } finally {
            f.close();
        }
    }
});

test("diagnostic stop remains responsive while a repair acknowledgement is pending", () => {
    const f = repairFixture();
    try {
        start(f);
        f.clock.advance(0);
        repairReply(f, repairCommand({ action: "reload_player" }));
        const result = f.pending("/repairs/results");
        const upload = f.pending("/events");
        f.clock.advance(1000);
        pollReply(
            f,
            control({
                action: "stop",
                lease_ms: 0,
                request_id: "request-stop",
            }),
            2
        );
        assert.equal(f.captures[0].releases, 1);
        assert.equal(upload.cancelled, true);
        assert.equal(f.client.snapshot().sessionId, null);
        assert.equal(
            JSON.parse(f.pending("/results").request.body).status,
            "applied"
        );
        assert.equal(f.execution.effects, 0);
        f.client.stop();
        f.reply(result, envelope({ status: "recorded" }));
        assert.equal(f.execution.effects, 0);
        assert.equal(f.execution.cancelled, 1);
    } finally {
        f.close();
    }
});

test("all five capabilities are accepted and completed repair IDs are bounded without eviction", () => {
    const f = repairFixture({
        capabilities: ["playback", "network", "input", "epg"],
    });
    try {
        repairReady(f);
        assert.deepEqual(JSON.parse(f.calls[0].request.body).capabilities, [
            "playback",
            "network",
            "input",
            "epg",
            "repairs",
        ]);
        for (let i = 0; i < 256; i++) {
            repairReply(f, repairCommand({ repair_id: "repair-" + i }));
            f.reply(
                f.pending("/repairs/results"),
                envelope({ status: "recorded" })
            );
            repairHeartbeat(f, 3000);
        }
        assert.equal(f.execution.effects, 256);
        repairReply(f, repairCommand({ repair_id: "repair-over-capacity" }));
        assert.equal(f.execution.effects, 256);
        assert.equal(
            f.client.snapshot().enabled,
            false,
            "exhausted runtime retires instead of evicting receipt history"
        );
        assertStopped(f);
    } finally {
        f.close();
    }
});

test("explicit unsupported and rejected repairs return bounded statuses without effects", () => {
    for (const status of ["unsupported", "rejected"]) {
        let effects = 0;
        const f = repairFixture({
            executeRepair(_action, complete, afterAck) {
                afterAck(() => {
                    effects++;
                });
                complete(status);
            },
        });
        try {
            repairReady(f);
            repairReply(f, repairCommand({ action: "reload_player" }));
            const result = f.pending("/repairs/results");
            assert.equal(JSON.parse(result.request.body).status, status);
            f.reply(result, envelope({ status: "recorded" }));
            assert.equal(effects, 0);
        } finally {
            f.close();
        }
    }
});

test("unknown local execution outcome never emits a false receipt or reruns its repair ID", () => {
    for (const throws of [false, true]) {
        let effects = 0;
        const f = repairFixture({
            executeRepair(_action, complete) {
                effects++;
                if (throws) throw new Error("unknown local outcome");
                complete("accepted"); // Invalid for a stream repair, not an acknowledged effect.
            },
        });
        try {
            repairReady(f);
            repairReply(f);
            assert.equal(f.pending("/repairs/results"), undefined);
            repairHeartbeat(f, 3000);
            repairReply(f);
            assert.equal(effects, 1);
            assert.equal(f.client.snapshot().enabled, true);
        } finally {
            f.close();
        }
    }
});

test("executor reentry and fully synchronous transport cannot leave or duplicate effects", () => {
    let f;
    let effects = 0;
    let cancelled = 0;
    f = repairFixture({
        executeRepair(_action, complete, afterAck) {
            afterAck(() => {
                effects++;
            });
            f.client.stop();
            complete("accepted");
            return () => {
                cancelled++;
            };
        },
    });
    try {
        repairReady(f);
        repairReply(f, repairCommand({ action: "reload_player" }));
        assert.equal(effects, 0);
        assert.equal(cancelled, 1);
        assert.equal(f.pending("/repairs/results"), undefined);
        assertStopped(f);
    } finally {
        f.close();
    }
    const synchronous = repairFixture({
        send(request, complete) {
            const response = request.url.endsWith("/runtimes")
                ? registration()
                : request.url.endsWith("/repairs/poll")
                  ? envelope({
                        repair: repairCommand({ action: "reload_player" }),
                    })
                  : request.url.endsWith("/repairs/results")
                    ? envelope({ status: "recorded" })
                    : envelope({
                          control: null,
                          control_revision: 0,
                          poll_after_ms: 3000,
                          runtime_id: "runtime-one",
                      });
            complete({
                body: JSON.stringify(response),
                status: request.url.endsWith("/runtimes") ? 201 : 200,
            });
            return () => {};
        },
    });
    try {
        synchronous.client.configure(config());
        synchronous.clock.advance(0);
        assert.equal(synchronous.execution.effects, 1);
        assert.equal(synchronous.execution.cancelled, 1);
        synchronous.clock.advance(3000);
        assert.equal(synchronous.execution.effects, 1);
    } finally {
        synchronous.close();
    }
});

test("wrong repair acknowledgement and conflicting duplicate action cannot dispatch reload", () => {
    for (const variant of ["ack", "duplicate", "epoch"]) {
        const f = repairFixture();
        try {
            repairReady(f);
            repairReply(f, repairCommand({ action: "reload_player" }));
            if (variant === "duplicate") {
                repairHeartbeat(f, 3000);
                repairReply(f, repairCommand({ action: "restart_stream" }));
            } else
                f.reply(
                    f.pending("/repairs/results"),
                    envelope(
                        { status: variant === "ack" ? "accepted" : "recorded" },
                        variant === "epoch" ? "server-two" : "server-one"
                    )
                );
            assert.equal(f.execution.effects, 0);
            assert.equal(f.client.snapshot().enabled, false);
            if (variant === "epoch")
                assert.equal(f.client.snapshot().reason, "server_restarted");
            assertStopped(f);
        } finally {
            f.close();
        }
    }
});

test("a new repair retires old unacknowledged reload intent without rejecting support", () => {
    const f = repairFixture();
    try {
        repairReady(f);
        repairReply(f, repairCommand({ action: "reload_player" }));
        const oldResult = f.pending("/repairs/results");
        repairHeartbeat(f, 3000);
        repairReply(
            f,
            repairCommand({ action: "restart_stream", repair_id: "repair-two" })
        );
        const nextResult = f.pending("/repairs/results");
        assert(oldResult.cancelled);
        assert.equal(
            f.execution.effects,
            1,
            "only the new stream repair executes"
        );
        assert.equal(f.execution.cancelled, 1);
        assert.equal(f.client.snapshot().enabled, true);
        f.reply(oldResult, envelope({ status: "recorded" }));
        assert.equal(
            f.execution.effects,
            1,
            "late previous ACK cannot dispatch the superseded reload"
        );
        assert.equal(f.pending("/repairs/results"), nextResult);
        assert.equal(
            JSON.parse(nextResult.request.body).repair_id,
            "repair-two"
        );
        f.reply(nextResult, envelope({ status: "recorded" }));
        repairHeartbeat(f, 3000);
        repairReply(f, repairCommand({ action: "reload_player" }));
        assert.equal(
            f.execution.calls.length,
            2,
            "superseded ID stays remembered"
        );
        assert.equal(f.execution.effects, 1);
    } finally {
        f.close();
    }
});

let failures = 0;
for (const { name, run } of tests) {
    try {
        run();
        console.log("PASS " + name);
    } catch (error) {
        failures++;
        console.error("FAIL " + name + "\n" + error.stack);
    }
}
assert.equal(failures, 0, failures + " remote diagnostics test(s) failed");
console.log("Remote diagnostics tests passed (" + tests.length + ").");
