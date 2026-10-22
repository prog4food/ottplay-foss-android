const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const source = fs.readFileSync(
    path.join(__dirname, "../src/plugins/command-server.ts"),
    "utf8"
);
const code = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES5,
    },
}).outputText;
acorn.parse(code, { ecmaVersion: 5 });
let clock = 1000000;
const moduleContext = {
    console,
    Date: { now: () => clock },
    exports: {},
    require(name) {
        assert.equal(name, "../shared/wire-contracts");
        return require("./load-wire.cjs")();
    },
    URL,
};
vm.runInNewContext(code, moduleContext);
const {
    createCommandServer,
    createCommandServerTransport,
    normalizeCommandServerAddress: normalize,
} = moduleContext.exports;
const token = "device_read_code_" + "a".repeat(32);
for (const [input, expected] of [
    ["192.168.1.20", "http://192.168.1.20:8081/api/webhook/commands"],
    ["player.local:9090", "http://player.local:9090/api/webhook/commands"],
    [
        "server.local?device_id=lounge",
        "http://server.local:8081/api/webhook/commands?device_id=lounge",
    ],
    [
        "server.local:8081?device_id=lounge",
        "http://server.local:8081/api/webhook/commands?device_id=lounge",
    ],
    [
        "server.local:9090?device_id=lounge",
        "http://server.local:9090/api/webhook/commands?device_id=lounge",
    ],
    [
        "server.local/remote?device_id=lounge:tv",
        "http://server.local:8081/remote/api/webhook/commands?device_id=lounge%3Atv",
    ],
    [
        "server.local/webhook/poll?device_id=lounge",
        "http://server.local:8081/api/webhook/commands?device_id=lounge",
    ],
    [
        "[::1]?device_id=lounge",
        "http://[::1]:8081/api/webhook/commands?device_id=lounge",
    ],
    [
        "2001:db8::1?device_id=lounge",
        "http://[2001:db8::1]:8081/api/webhook/commands?device_id=lounge",
    ],
    [
        "[2001:db8::1]:9090?device_id=lounge",
        "http://[2001:db8::1]:9090/api/webhook/commands?device_id=lounge",
    ],
    ["[::1]", "http://[::1]:8081/api/webhook/commands"],
    ["2001:db8::1", "http://[2001:db8::1]:8081/api/webhook/commands"],
    ["[2001:db8::1]:9090", "http://[2001:db8::1]:9090/api/webhook/commands"],
    [
        "https://server.example/remote/",
        "https://server.example/remote/api/webhook/commands",
    ],
    [
        "http://server.example/webhook/poll?device_id=living-room",
        "http://server.example/api/webhook/commands?device_id=living-room",
    ],
    [
        "https://server.example/api/webhook/commands",
        "https://server.example/api/webhook/commands",
    ],
])
    assert.equal(normalize(input), expected, input);
for (const input of [
    "",
    "ftp://host",
    "javascript:alert(1)",
    "https://user:pass@host",
    "https://host#secret",
    "https://host?token=secret",
    "https://host?device_id=a&token=b",
    "host:abc",
    "http://host\\@evil",
    "[notipv6]",
    "http://host:99999",
    "host?token=secret",
    "host:8081?token=secret",
    "host?device_id=lounge&token=secret",
    "host?device_id=lounge&device_id=other",
    "host?device_id=",
    "host?device_id=lounge%26token%3Dsecret",
    "user:pass@host?device_id=lounge",
    "host:abc?device_id=lounge",
    "host:99999?device_id=lounge",
]) {
    assert.throws(() => normalize(input), undefined, input);
}
function harness(protocol = "http:", execute, accept) {
    const jobs = new Map();
    const requests = [];
    const saved = [];
    const delivered = [];
    const behavior = { outcome: undefined };
    let sequence = 0;
    const w = {
        clearTimeout(id) {
            jobs.delete(id);
        },
        location: { protocol },
        setTimeout(fn, delay) {
            jobs.set(++sequence, { delay, fn });
            return sequence;
        },
    };
    const controller = createCommandServer(
        w,
        (request, complete) => {
            const call = { aborted: false, complete, request };
            requests.push(call);
            return () => {
                call.aborted = true;
            };
        },
        (value) => saved.push({ ...value }),
        (command) => {
            if (behavior.outcome !== "deferred") delivered.push(command);
            if (behavior.onDispatch) behavior.onDispatch();
            return behavior.outcome;
        },
        execute,
        accept
    );
    function next() {
        assert.equal(jobs.size, 1, "only one retry/poll timer is scheduled");
        const [id, job] = [...jobs][0];
        jobs.delete(id);
        job.fn();
        return job.delay;
    }
    function respond(body, status = 200) {
        requests.at(-1).complete({ body: JSON.stringify(body), status });
    }
    function connect(extra = {}) {
        controller.configure({
            address: "server.local",
            enabled: true,
            token,
            ...extra,
        });
    }
    return {
        behavior,
        connect,
        controller,
        delivered,
        jobs,
        next,
        requests,
        respond,
        saved,
        w,
    };
}
const bareQuery = harness();
bareQuery.connect({ address: "server.local?device_id=lounge" });
assert.equal(
    bareQuery.requests[0].request.url,
    "http://server.local:8081/api/webhook/commands?device_id=lounge&delivery=ack"
);
bareQuery.respond({
    commands: [{ command: "popup_message", id: "scoped", message: "Fixture" }],
});
bareQuery.next();
assert.equal(
    bareQuery.requests[1].request.url,
    "http://server.local:8081/api/webhook/commands/ack?device_id=lounge"
);
assert.deepEqual(JSON.parse(bareQuery.requests[1].request.body), {
    ids: ["scoped"],
});
const h = harness();
assert.equal(h.controller.status().enabled, false);
assert.equal(h.requests.length, 0);
h.connect();
assert.equal(
    h.requests.length,
    1,
    "supplied code works without crypto or a native listener"
);
assert.equal(
    h.saved[0].enabled,
    false,
    "persist disabled before granting connection"
);
assert.equal(h.saved.at(-1).enabled, true);
assert.equal(h.requests[0].request.headers.Authorization, "Bearer " + token);
assert.equal(
    new URL(h.requests[0].request.url).search,
    "?delivery=ack",
    "strict server query contract has no cache-buster"
);
assert.ok(!h.requests[0].request.url.includes(token));
assert.ok(!JSON.stringify(h.controller.status()).includes(token));
h.controller.poll();
assert.equal(h.requests.length, 1, "no overlapping request");
h.respond({
    commands: [
        { command: "set_volume", id: "one", volume_step: 5 },
        { channel_number: 2, command: "channel_by_number", id: "two" },
    ],
});
assert.equal(h.delivered.length, 2);
assert.equal(h.next(), 0);
assert.equal(h.requests[1].request.method, "POST");
assert.equal(
    h.requests[1].request.url,
    "http://server.local:8081/api/webhook/commands/ack"
);
assert.deepEqual(JSON.parse(h.requests[1].request.body), {
    ids: ["one", "two"],
});
h.respond({ error: "offline" }, 503);
assert.equal(h.controller.status().state, "error");
assert.ok(h.next() >= 2000);
assert.equal(
    h.requests[2].request.method,
    "POST",
    "retry the ACK before polling more commands"
);
assert.equal(h.delivered.length, 2, "lost ACK cannot repeat a volume step");
h.respond({ acknowledged: 2, status: "ok" });
assert.equal(h.next(), 1000);
h.respond({
    commands: [
        { command: "set_volume", id: "one", volume_step: 5 },
        { command: "popup_message", id: "three", message: "new" },
    ],
});
assert.deepEqual(
    h.delivered.map((x) => x.id),
    ["one", "two", "three"]
);
h.next();
h.respond({ acknowledged: 2, status: "ok" });
h.next();
const old = h.requests.at(-1);
h.connect({ address: "other.local", token: "b".repeat(64) });
assert.equal(old.aborted, true);
old.complete({
    body: JSON.stringify({
        commands: [{ command: "exit_player", id: "stale" }],
    }),
    status: 200,
});
assert.equal(
    h.delivered.length,
    3,
    "old endpoint/token cannot deliver after reconfiguration"
);
const latest = h.requests.at(-1);
h.controller.configure({
    address: "other.local",
    enabled: false,
    token: "b".repeat(64),
});
assert.equal(latest.aborted, true);
latest.complete({
    body: '{"commands":[{"id":"late","command":"exit_player"}]}',
    status: 200,
});
assert.equal(h.delivered.length, 3);
assert.equal(h.jobs.size, 0);
assert.equal(h.controller.status().enabled, false);
// Reconnecting the same device queue must not repeat a non-idempotent command
// when delivery succeeded but its ACK did not reach the server.
const reconnect = harness();
const volumeStep = { command: "set_volume", id: "reconnect", volume_step: 5 };
reconnect.connect();
reconnect.respond({ commands: [volumeStep] });
reconnect.next();
reconnect.respond({}, 503);
reconnect.controller.configure({
    address: "server.local",
    enabled: false,
    token,
});
assert.equal(reconnect.jobs.size, 0);
reconnect.connect({ address: "http://server.local:8081/api/webhook/commands" });
reconnect.respond({ commands: [volumeStep] });
assert.equal(
    reconnect.delivered.length,
    1,
    "same normalized queue keeps dedupe history"
);
reconnect.next();
assert.deepEqual(JSON.parse(reconnect.requests.at(-1).request.body), {
    ids: [volumeStep.id],
});
const oldAck = reconnect.requests.at(-1);
reconnect.connect();
assert.equal(oldAck.aborted, true);
oldAck.complete({ body: '{"status":"ok"}', status: 200 });
assert.equal(reconnect.jobs.size, 0, "retired ACK cannot schedule a poll");
reconnect.respond({ commands: [volumeStep] });
assert.equal(reconnect.delivered.length, 1);
reconnect.connect({ token: "b".repeat(64) });
reconnect.respond({ commands: [volumeStep] });
assert.equal(
    reconnect.delivered.length,
    2,
    "a different device token has its own queue"
);
reconnect.connect({ address: "other.local", token: "b".repeat(64) });
reconnect.respond({ commands: [volumeStep] });
assert.equal(
    reconnect.delivered.length,
    3,
    "a different endpoint has its own queue"
);
reconnect.controller.configure({
    address: "edited.local",
    enabled: false,
    token,
});
reconnect.connect({ address: "other.local", token: "b".repeat(64) });
reconnect.respond({ commands: [volumeStep] });
assert.equal(
    reconnect.delivered.length,
    4,
    "disabled identity edits retire previous history"
);
assert.ok(!JSON.stringify(reconnect.controller.status()).includes(token));

const reentrant = harness();
reentrant.behavior.onDispatch = () => {
    reentrant.behavior.onDispatch = null;
    reentrant.connect();
};
reentrant.connect();
reentrant.respond({ commands: [volumeStep] });
reentrant.respond({ commands: [volumeStep] });
assert.equal(
    reentrant.delivered.length,
    1,
    "dispatch-triggered reconnect retains completed ID"
);

const bounded = harness();
bounded.connect();
for (let batch = 0; batch < 9; batch++) {
    const start = batch * 256;
    bounded.respond({
        commands: Array.from({ length: 256 }, (_, i) => ({
            command: "popup_message",
            id: "history-" + (start + i),
        })),
    });
    // Reconnect retires pending requests, not history. Exercise the bound across generations.
    bounded.connect();
}
bounded.respond({
    commands: [
        { command: "popup_message", id: "history-0" },
        { command: "popup_message", id: "history-2303" },
    ],
});
assert.equal(
    bounded.delivered.length,
    2305,
    "bounded history evicts oldest IDs and retains newest"
);
assert.equal(bounded.delivered.at(-1).id, "history-0");

const denied = harness();
denied.connect();
denied.respond({}, 401);
assert.match(denied.controller.status().message, /access code/i);
const invalid = harness();
invalid.connect({ token: "short" });
assert.equal(invalid.requests.length, 0);
assert.equal(invalid.saved.at(-1).enabled, false);
const secure = harness("https:");
secure.connect();
assert.equal(secure.requests.length, 0);
assert.match(secure.controller.status().message, /HTTPS player cannot connect/);
secure.connect({ address: "https://server.local" });
assert.equal(secure.requests.length, 1);
const native = harness("https:");
native.w.__TAURI__ = {};
native.connect();
assert.equal(
    native.requests.length,
    1,
    "native HTTP does not use WebView mixed content"
);
const malformed = harness();
malformed.connect();
malformed.respond([{ command: "exit_player", id: "legacy" }]);
assert.equal(
    malformed.delivered.length,
    0,
    "a destructive legacy endpoint is never silently accepted in ACK mode"
);
assert.equal(malformed.controller.status().state, "error");
malformed.next();
malformed.respond({
    commands: [
        { command: "exit_player", id: "valid" },
        { command: "exit_player" },
    ],
});
assert.equal(
    malformed.delivered.length,
    0,
    "validate complete envelope before executing any command"
);
const collision = harness();
collision.connect();
collision.respond({
    commands: [
        { command: "popup_message", id: "__proto__" },
        { command: "popup_message", id: "constructor" },
    ],
});
assert.equal(
    collision.delivered.length,
    2,
    "IDs cannot collide with Object.prototype"
);
const query = harness();
query.connect({ address: "https://host/webhook/poll?device_id=lounge" });
query.respond({ commands: [{ command: "exit_player", id: "x" }] });
query.next();
assert.equal(
    query.requests.at(-1).request.url,
    "https://host/api/webhook/commands/ack?device_id=lounge"
);

// Keep channel commands on the server while boot is incomplete, then ACK exactly once.
const boot = harness();
boot.behavior.outcome = "deferred";
boot.connect();
const queued = {
    commands: [
        {
            channel_number: 1,
            command: "channel_by_number",
            expires_at: 5010,
            id: "boot",
        },
    ],
    server_time: 5000,
};
boot.respond(queued);
assert.equal(boot.delivered.length, 0);
assert.equal(boot.controller.status().state, "waiting");
boot.next();
assert.equal(
    boot.requests.at(-1).request.method,
    "GET",
    "unready commands must remain unacknowledged"
);
clock += 1000;
boot.behavior.outcome = undefined;
boot.respond({ ...queued, server_time: 5001 });
assert.equal(boot.delivered.length, 1);
boot.next();
assert.equal(boot.requests.at(-1).request.method, "POST");
boot.respond({ status: "ok" });
boot.next();
boot.respond({ ...queued, server_time: 5002 });
assert.equal(boot.delivered.length, 1);
const expired = harness();
expired.behavior.outcome = "deferred";
expired.connect();
expired.respond(queued);
expired.next();
clock += 11000;
expired.behavior.outcome = undefined;
expired.respond({ ...queued, server_time: 5011 });
assert.equal(expired.delivered.length, 0);
assert.match(expired.controller.status().message, /expired/);
expired.next();
assert.equal(
    expired.requests.at(-1).request.method,
    "POST",
    "expired commands are retired without executing"
);
const capped = harness();
capped.behavior.outcome = "deferred";
capped.connect();
capped.respond({ commands: [{ command: "random_channel", id: "capped" }] });
capped.next();
clock += 60001;
capped.behavior.outcome = undefined;
capped.respond({ commands: [{ command: "random_channel", id: "capped" }] });
assert.equal(
    capped.delivered.length,
    0,
    "old servers without expiry metadata use a bounded60s client wait"
);
const rejected = harness();
rejected.behavior.outcome = "unsupported";
rejected.connect();
rejected.respond({
    commands: [{ command: "change_provider_settings", id: "unsupported" }],
});
assert.match(rejected.controller.status().message, /rejected/);
const batch = harness();
batch.connect();
batch.respond({
    commands: Array.from({ length: 55 }, (_, i) => ({
        command: "popup_message",
        id: "batch" + i,
    })),
});
batch.next();
assert.equal(JSON.parse(batch.requests.at(-1).request.body).ids.length, 50);
batch.respond({ status: "ok" });
batch.next();
assert.equal(JSON.parse(batch.requests.at(-1).request.body).ids.length, 5);
batch.respond({ status: "ok" });
assert.equal(batch.next(), 1000);
assert.equal(batch.requests.at(-1).request.method, "GET");

// Real transport contracts: native promises, timeout/abort, browser headers/body.
(async () => {
    const t = harness();
    let resolveNative;
    let nativeRequest;
    const completed = [];
    const transport = createCommandServerTransport(
        t.w,
        (value) =>
            new Promise((resolve) => {
                nativeRequest = value;
                resolveNative = resolve;
            })
    );
    const request = {
        body: '{"ids":["one"]}',
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
        },
        method: "POST",
        timeoutMs: 8000,
        url: "http://host/api/webhook/commands/ack",
    };
    const abort = transport(request, (value) => completed.push(value));
    abort();
    resolveNative({ body: "{}", status: 200 });
    await Promise.resolve();
    assert.equal(completed.length, 0, "native results after abort are ignored");
    assert.equal(t.jobs.size, 0);
    transport(request, (value) => completed.push(value));
    t.next();
    assert.equal(completed.length, 1);
    assert.equal(completed[0], undefined);
    resolveNative({ body: "{}", status: 200 });
    await Promise.resolve();
    assert.equal(completed.length, 1);
    let xhr;
    t.w.XMLHttpRequest = class {
        constructor() {
            xhr = this;
            this.headers = {};
        }
        open(method, url, async) {
            Object.assign(this, { async, method, url });
        }
        setRequestHeader(name, value) {
            this.headers[name] = value;
        }
        send(body) {
            this.body = body;
        }
        abort() {
            this.aborted = true;
            this.onabort();
        }
    };
    const browserTransport = createCommandServerTransport(t.w);
    const browserAbort = browserTransport(request, (value) =>
        completed.push(value)
    );
    assert.equal(xhr.method, "POST");
    assert.equal(xhr.body, request.body);
    assert.equal(xhr.headers.Authorization, "Bearer " + token);
    assert.equal(xhr.timeout, 8000);
    browserAbort();
    assert.equal(xhr.aborted, true);
    assert.equal(completed.length, 1);
    browserTransport(request, (value) => completed.push(value));
    xhr.status = 403;
    xhr.responseText = "denied";
    xhr.onload();
    assert.deepEqual({ ...completed[1] }, { body: "denied", status: 403 });
    assert.equal(t.jobs.size, 0);
    const secure = {
        ...request,
        body: undefined,
        method: "GET",
        secureControl: true,
        url: "https://host/api/pairings?id=" + "a".repeat(32),
    };
    const cancelNativeSecure = transport(secure, () => {});
    assert.equal(nativeRequest.secureControl, true);
    assert.equal(nativeRequest.url, secure.url);
    cancelNativeSecure();
    const nativeCancellations = [];
    const screenshotTransport = createCommandServerTransport(
        t.w,
        (value) => {
            nativeRequest = value;
            return new Promise((resolve) => {
                resolveNative = resolve;
            });
        },
        (id) => nativeCancellations.push(id)
    );
    const screenshotRequest = {
        ...request,
        screenshotControl: true,
        url: "https://host/api/responses",
    };
    const cancelScreenshot = screenshotTransport(screenshotRequest, () => {});
    assert.match(nativeRequest.requestId, /^ott_shot_\d+_\d+$/);
    const firstRequestId = nativeRequest.requestId;
    cancelScreenshot();
    cancelScreenshot();
    assert.deepEqual(nativeCancellations, [firstRequestId]);
    screenshotTransport({ ...screenshotRequest }, () => {});
    assert.notEqual(nativeRequest.requestId, firstRequestId);
    t.next();
    assert.equal(
        nativeCancellations.length,
        2,
        "native timeout cancels upload"
    );
    const secureResults = [];
    const acceptSecure = (value) => secureResults.push(value);
    browserTransport(secure, acceptSecure);
    assert.equal(secureResults.at(-1).error, "secure_control_unavailable");
    const originalXhr = xhr;
    let fetched;
    let resolveFetch;
    let rejectFetch;
    t.w.Request = Request;
    t.w.fetch = (value) => {
        fetched = value;
        return new Promise((resolve, reject) => {
            resolveFetch = resolve;
            rejectFetch = reject;
        });
    };
    browserTransport(secure, acceptSecure);
    assert.equal(secureResults.at(-1).error, "secure_control_unavailable");
    assert.equal(fetched, undefined, "uncancellable Fetch never starts");
    secureResults.pop();
    t.w.AbortController = AbortController;
    const cancelFetch = browserTransport(secure, acceptSecure);
    assert.equal(fetched.redirect, "error");
    assert.equal(fetched.credentials, "omit");
    assert.equal(fetched.url, secure.url);
    assert.equal(fetched.headers.get("Authorization"), "Bearer " + token);
    cancelFetch();
    assert.equal(fetched.signal.aborted, true);
    resolveFetch(new Response("{}", { status: 200 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        secureResults.length,
        1,
        "late secure fetch responses are ignored"
    );
    browserTransport(secure, acceptSecure);
    rejectFetch(new TypeError("redirect blocked"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secureResults.at(-1), undefined);
    browserTransport(secure, acceptSecure);
    t.next();
    assert.equal(
        fetched.signal.aborted,
        true,
        "secure fetch timeout aborts request"
    );
    resolveFetch(new Response("{}", { status: 200 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secureResults.length, 3);
    browserTransport(secure, acceptSecure);
    resolveFetch(new Response('{"status":"pending"}', { status: 202 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        { ...secureResults.at(-1) },
        {
            body: '{"status":"pending"}',
            status: 202,
        }
    );
    const previousFetch = fetched;
    for (const url of [
        "http://host/api/pairings",
        "https://user:pass@host/api/pairings",
        "https://host/api/pairings#fragment",
    ])
        browserTransport({ ...secure, url }, acceptSecure);
    assert.equal(fetched, previousFetch, "invalid secure URLs are never sent");
    t.w.Request = function () {};
    browserTransport(secure, acceptSecure);
    assert.equal(secureResults.at(-1).error, "secure_control_unavailable");
    assert.equal(
        fetched,
        previousFetch,
        "a Request polyfill ignoring redirect is rejected"
    );
    assert.equal(xhr, originalXhr, "secure requests never fall back to XHR");
    assert.equal(t.jobs.size, 0);
    console.log(
        "PASS command server: ES5, address/auth policy, independent consent, ACK retry/dedup, revocation, backoff, native/XHR cancellation and timeouts"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// Request execution is invalidated by reconnects, and network delay cannot
// revive a request whose server deadline has already passed.
{
    let completeWork;
    let cancellations = 0;
    let executions = 0;
    const rpc = harness("http:", (_request, done) => {
        executions++;
        completeWork = done;
        return () => cancellations++;
    });
    const id = "a".repeat(32);
    rpc.connect({ address: "https://server.example/base" });
    rpc.respond({
        commands: [],
        requests: [
            { action: "status", expires_at: clock / 1000 + 5, id, params: {} },
        ],
        server_time: clock / 1000,
    });
    assert.equal(executions, 1);
    rpc.controller.configure({
        address: "https://server.example/base",
        enabled: false,
        token,
    });
    assert.equal(cancellations, 1);
    completeWork({ data: { volume: 22 }, status: "ok" });
    assert.equal(rpc.jobs.size, 0, "revoked work cannot enqueue a response");
    rpc.connect();
    const serverTime = clock / 1000;
    clock += 3000;
    rpc.respond({
        commands: [],
        requests: [
            { action: "status", expires_at: serverTime + 1, id, params: {} },
        ],
        server_time: serverTime,
    });
    assert.equal(executions, 1, "expired request is never dispatched");
    rpc.next();
    rpc.respond({
        commands: [],
        requests: [
            { action: "status", expires_at: clock / 1000 + 30, id, params: {} },
        ],
        server_time: clock / 1000,
    });
    completeWork({ data: { volume: 22 }, status: "ok" });
    rpc.next();
    assert.equal(
        rpc.requests.at(-1).request.url,
        "http://server.local:8081/api/responses"
    );
    rpc.respond({ error: "expired" }, 404);
    rpc.next();
    assert.match(rpc.requests.at(-1).request.url, /delivery=ack$/);
    console.log(
        "PASS RPC transport cancellation, server-relative expiry and expired-result recovery"
    );
}

// Plex and media-step implementations use a local deadline internally. A TV's
// wall clock may differ from the controller, but network delay still consumes TTL.
{
    const previousClock = clock;
    for (const action of ["plex_queue", "plex_library", "playback"])
        for (const skew of [-120, 120])
            for (const lifetime of [30, 90]) {
                clock = 5000000;
                const started = clock;
                const serverTime = started / 1000 + skew;
                const params =
                    action === "plex_queue"
                        ? { ids: ["1", "2"], op: "play", runtime: "page-1" }
                        : action === "plex_library"
                          ? { library_id: "16", op: "play", runtime: "page-1" }
                          : { operation: "next_channel" };
                let dispatched;
                let completeWork;
                let cancellations = 0;
                const rpc = harness("http:", (request, done) => {
                    dispatched = request;
                    completeWork = done;
                    return () => cancellations++;
                });
                rpc.connect();
                clock += 2500;
                rpc.respond({
                    commands: [],
                    requests: [
                        {
                            action,
                            expires_at: serverTime + lifetime,
                            id: "c".repeat(32),
                            params,
                        },
                    ],
                    server_time: serverTime,
                });
                const deadline = Math.min(
                    started + lifetime * 1000,
                    clock + 40000
                );
                assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), {
                    action,
                    expires_at: deadline / 1000,
                    id: "c".repeat(32),
                    params,
                });
                assert(dispatched.expires_at * 1000 > clock);
                const remaining = deadline - clock;
                clock = deadline;
                assert.equal(rpc.next(), remaining);
                assert.equal(cancellations, 1);
                completeWork({ data: { dispatched: true }, status: "ok" });
                rpc.next();
                const result = JSON.parse(rpc.requests.at(-1).request.body);
                assert.equal(result.status, "rejected");
                assert.match(result.data.error, /timed out/i);
                if (action === "plex_library")
                    assert.deepEqual(result.data, {
                        error: "Plex queue request timed out.",
                        op: "play",
                        runtime: "page-1",
                        state: "error",
                        version: 1,
                    });
            }
    clock = previousClock;
    console.log(
        "PASS Plex/media-step local deadlines: clock skew, network delay, execution cap and late completion"
    );
}

// A malformed result must become an explicit rejection, not strand the poller
// after its execution timer was already cleared.
for (const value of [
    null,
    { data: undefined, status: "ok" },
    { data: { value: 1 }, status: "unknown" },
    {
        data: (() => {
            const cyclic = {};
            cyclic.self = cyclic;
            return cyclic;
        })(),
        status: "ok",
    },
]) {
    const rpc = harness("http:", (_request, done) => done(value));
    rpc.connect();
    rpc.respond({
        commands: [],
        requests: [
            {
                action: "status",
                expires_at: 5030,
                id: "b".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    });
    assert.equal(
        rpc.next(),
        0,
        "malformed completion still schedules a response"
    );
    const result = JSON.parse(rpc.requests.at(-1).request.body);
    assert.equal(result.status, "rejected");
    assert.match(result.data.error, /result/i);
    rpc.respond({ status: "ok" });
    rpc.next();
    assert.equal(rpc.requests.at(-1).request.method, "GET");
}

// Cache the serialized snapshot. Native/provider code can retain and mutate
// its result object after calling done; a lost ACK must retry the same bytes.
{
    const result = {
        data: {
            diagnostics: {
                epg: { available: true, enabled: true, phase: "download" },
                input: { available: true, enabled: false },
                version: 1,
            },
            volume: 35,
        },
        status: "ok",
    };
    let executions = 0;
    const rpc = harness("http:", (_request, done) => {
        executions++;
        done(result);
    });
    const envelope = {
        commands: [],
        requests: [
            {
                action: "status",
                expires_at: 5030,
                id: "c".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    };
    rpc.connect();
    rpc.respond(envelope);
    result.data.volume = 70;
    result.data.diagnostics.epg.phase = "ready";
    rpc.next();
    const body = rpc.requests.at(-1).request.body;
    assert.equal(JSON.parse(body).data.volume, 35);
    assert.equal(JSON.parse(body).data.diagnostics.epg.phase, "download");
    assert.deepEqual(JSON.parse(body).data.diagnostics.input, {
        available: true,
        enabled: false,
    });
    rpc.respond({}, 503);
    result.data.volume = 90;
    rpc.next();
    assert.equal(rpc.requests.at(-1).request.body, body);
    rpc.respond({ status: "ok" });
    rpc.next();
    rpc.respond(envelope);
    rpc.next();
    assert.equal(rpc.requests.at(-1).request.body, body);
    assert.equal(executions, 1, "replayed request uses its immutable result");
}

// Known queued work is fetched as soon as the prior result is acknowledged.
// Eight quick requests previously accumulated seven seconds of idle delay.
{
    const rpc = harness("http:", (_request, done) =>
        done({ data: {}, status: "ok" })
    );
    const requests = Array.from({ length: 8 }, (_, i) => ({
        action: "status",
        expires_at: 5030,
        id: i.toString(16).padStart(32, "0"),
        params: {},
    }));
    rpc.connect();
    let idleDelay = 0;
    while (requests.length) {
        rpc.respond({
            commands: [],
            requests: requests.slice(),
            server_time: 5000,
        });
        assert.equal(rpc.next(), 0);
        rpc.respond({ status: "ok" });
        requests.shift();
        const delay = rpc.next();
        if (requests.length) idleDelay += delay;
        else
            assert.equal(
                delay,
                1000,
                "empty queues keep the normal poll interval"
            );
    }
    assert.equal(
        idleDelay,
        0,
        "known work never waits for the idle poll interval"
    );
}
console.log(
    "PASS RPC malformed results, immutable retries and burst drain latency"
);

// A queue can expire or become invalid between draining polls. Its old backlog
// hint must not turn an empty/malformed response into a zero-delay polling loop.
for (const pending of [[], [{ expires_at: 5030, id: "invalid" }]]) {
    const rpc = harness("http:", (_request, done) =>
        done({ data: {}, status: "ok" })
    );
    rpc.connect();
    rpc.respond({
        commands: [],
        requests: ["d", "e"].map((id) => ({
            action: "status",
            expires_at: 5030,
            id: id.repeat(32),
            params: {},
        })),
        server_time: 5000,
    });
    rpc.next();
    rpc.respond({ status: "ok" });
    assert.equal(rpc.next(), 0);
    rpc.respond({ commands: [], requests: pending, server_time: 5000 });
    assert.equal(
        rpc.next(),
        1000,
        "stale backlog does not cause a busy poll loop"
    );
}

// Native/provider cancellation must not block revocation or prevent the timeout
// rejection from being delivered. A late success cannot replace that rejection.
for (const revoke of [false, true]) {
    let done;
    let cancellations = 0;
    const rpc = harness("http:", (_request, complete) => {
        done = complete;
        return () => {
            cancellations++;
            throw new Error("native cancellation failed");
        };
    });
    rpc.connect();
    rpc.respond({
        commands: [],
        requests: [
            {
                action: "status",
                expires_at: 5030,
                id: "f".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    });
    if (revoke) {
        rpc.controller.configure({
            address: "server.local",
            enabled: false,
            token,
        });
        done({ data: {}, status: "ok" });
        assert.equal(rpc.jobs.size, 0);
        assert.equal(rpc.controller.status().enabled, false);
    } else {
        assert.equal(rpc.next(), 30000);
        done({ data: {}, status: "ok" });
        rpc.next();
        const result = JSON.parse(rpc.requests.at(-1).request.body);
        assert.equal(result.status, "rejected");
        assert.match(result.data.error, /timed out/);
    }
    assert.equal(cancellations, 1);
}

// Some commands can synchronously reload/reconfigure the player. The old
// execution must not install a cancellation callback onto the new generation.
{
    let executions = 0;
    let oldCancellations = 0;
    let newCancellations = 0;
    let oldDone;
    const rpc = harness("http:", (_request, done) => {
        executions++;
        if (executions === 1) {
            oldDone = done;
            rpc.connect();
            return () => oldCancellations++;
        }
        return () => newCancellations++;
    });
    const envelope = {
        commands: [],
        requests: [
            {
                action: "status",
                expires_at: 5030,
                id: "a".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    };
    rpc.connect();
    rpc.respond(envelope);
    assert.equal(oldCancellations, 1);
    assert.equal(rpc.jobs.size, 0, "old execution timer is retired");
    rpc.respond(envelope);
    oldDone({ data: {}, status: "ok" });
    rpc.controller.configure({
        address: "server.local",
        enabled: false,
        token,
    });
    assert.equal(oldCancellations, 1);
    assert.equal(newCancellations, 1);
    assert.equal(rpc.jobs.size, 0);
}
console.log(
    "PASS RPC backlog expiry and exception-safe cancellation/reconfiguration"
);

// Even if a stale intermediary repeats an acknowledged batch, cached work is
// not executed again and the retry cadence falls back to the idle interval.
{
    let executions = 0;
    const rpc = harness("http:", (_request, done) => {
        executions++;
        done({ data: {}, status: "ok" });
    });
    const envelope = {
        commands: [],
        requests: ["1", "2"].map((id) => ({
            action: "status",
            expires_at: 5030,
            id: id.repeat(32),
            params: {},
        })),
        server_time: 5000,
    };
    rpc.connect();
    rpc.respond(envelope);
    rpc.next();
    rpc.respond({ status: "ok" });
    assert.equal(rpc.next(), 0);
    for (let i = 0; i < 3; i++) {
        rpc.respond(envelope);
        rpc.next();
        rpc.respond({ status: "ok" });
        assert.equal(
            rpc.next(),
            1000,
            "cached replay is not evidence of progress"
        );
    }
    assert.equal(executions, 1);
}

// Result byte limits survive non-ASCII data and JSON escaping; cache eviction
// is bounded by both retained characters and IDs, independently of reconnects.
{
    let executions = 0;
    let payload = "";
    const rpc = harness("http:", (_request, done) => {
        executions++;
        done({ data: { payload }, status: "ok" });
    });
    const ask = (id) => {
        rpc.connect();
        rpc.respond({
            commands: [],
            requests: [
                {
                    action: "channels",
                    expires_at: 5030,
                    id: id.toString(16).padStart(32, "0"),
                    params: {},
                },
            ],
            server_time: 5000,
        });
        rpc.next();
        return rpc.requests.at(-1).request.body;
    };
    for (const text of [
        "x".repeat(1800000),
        "я".repeat(800000),
        "\\".repeat(400000),
        "😀".repeat(400000),
    ]) {
        payload = text;
        const body = ask(executions + 1);
        assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024);
        assert.equal(JSON.parse(body).status, "ok");
        assert.equal(JSON.parse(body).data.payload, payload);
    }
    for (const text of [
        "я".repeat(1050000),
        "\\".repeat(1050000),
        "😀".repeat(530000),
        "界".repeat(700000),
    ]) {
        payload = text;
        const body = ask(executions + 1);
        assert.ok(Buffer.byteLength(body) < 2 * 1024 * 1024);
        assert.equal(JSON.parse(body).status, "rejected");
        assert.match(JSON.parse(body).data.error, /too large/);
    }
    payload = "x".repeat(600000);
    for (let id = 10; id < 14; id++)
        assert.equal(JSON.parse(ask(id)).status, "ok");
    let before = executions;
    ask(13);
    assert.equal(executions, before, "newest large response is retained");
    ask(10);
    assert.equal(
        executions,
        before + 1,
        "character budget evicts oldest response before 50 IDs"
    );
    payload = "small";
    for (let id = 100; id < 151; id++) ask(id);
    before = executions;
    ask(150);
    assert.equal(executions, before, "newest small response is retained");
    ask(100);
    assert.equal(
        executions,
        before + 1,
        "ID budget evicts the oldest small response"
    );
}

// A result serializer can re-enter configuration just like a native callback.
// Nothing from the retired identity may be queued or cached in the new one.
{
    let executions = 0;
    const rpc = harness("http:", (_request, done) => {
        executions++;
        done({
            data:
                executions === 1
                    ? {
                          toJSON() {
                              rpc.connect({ address: "other.local" });
                              return { volume: 1 };
                          },
                      }
                    : { volume: 2 },
            status: "ok",
        });
    });
    const envelope = {
        commands: [],
        requests: [
            {
                action: "status",
                expires_at: 5030,
                id: "3".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    };
    rpc.connect();
    rpc.respond(envelope);
    assert.equal(rpc.jobs.size, 0);
    rpc.respond(envelope);
    assert.equal(
        executions,
        2,
        "new identity cannot see the retired result cache"
    );
    rpc.next();
    assert.match(rpc.requests.at(-1).request.url, /other\.local/);
    assert.equal(JSON.parse(rpc.requests.at(-1).request.body).data.volume, 2);
}
console.log(
    "PASS RPC cached-replay cadence, response/cache bounds and identity isolation"
);

// Reload capabilities survive a lost POST response, but never enter replay history.
function effectRequest(expires = 5030) {
    return {
        commands: [],
        requests: [
            { action: "restart", expires_at: expires, id: "d".repeat(32) },
        ],
        server_time: 5000,
    };
}
{
    let effects = 0;
    let executions = 0;
    const rpc = harness("http:", (_request, done, afterReply) => {
        executions++;
        afterReply(() => effects++);
        afterReply(() => (effects += 100));
        done({ data: { accepted: true, dispatched: false }, status: "ok" });
        afterReply(() => (effects += 1000));
    });
    rpc.connect();
    rpc.respond(effectRequest());
    assert.equal(effects, 0);
    rpc.next();
    const body = rpc.requests.at(-1).request.body;
    assert.equal(JSON.parse(body).data.dispatched, false);
    rpc.respond({}, 0);
    assert.equal(effects, 0);
    rpc.next();
    assert.equal(rpc.requests.at(-1).request.body, body);
    rpc.respond({ status: "ok" });
    assert.equal(effects, 1);
    rpc.next();
    rpc.respond(effectRequest());
    rpc.next();
    rpc.respond({ status: "ok" });
    assert.equal(executions, 1);
    assert.equal(effects, 1, "cached result replay must not reload again");
}
for (const mode of [
    "expired",
    "cap",
    "404",
    "reconfigured",
    "invalid",
    "rejected",
    "oversize",
]) {
    let effects = 0;
    const rpc = harness("http:", (_request, done, afterReply) => {
        afterReply(() => effects++);
        done({
            data:
                mode === "invalid"
                    ? undefined
                    : mode === "oversize"
                      ? "x".repeat(2 * 1024 * 1024)
                      : {},
            status: mode === "rejected" ? "rejected" : "ok",
        });
    });
    rpc.connect();
    rpc.respond(effectRequest(mode === "cap" ? 5100 : 5002));
    rpc.next();
    const oldResponse = rpc.requests.at(-1);
    if (mode === "expired") clock += 2000;
    if (mode === "cap") clock += 40000;
    if (mode === "reconfigured") rpc.connect();
    oldResponse.complete({
        body: '{"status":"ok"}',
        status: mode === "404" ? 404 : 200,
    });
    assert.equal(effects, 0, mode + " must discard its reload capability");
}
{
    let effects = 0;
    let canceled = 0;
    const rpc = harness("http:", (_request, _done, afterReply) => {
        afterReply(() => effects++);
        return () => canceled++;
    });
    rpc.connect();
    rpc.respond(effectRequest());
    rpc.next(); // Execution deadline rejects and cancels the unfinished operation.
    rpc.next();
    rpc.respond({ status: "ok" });
    assert.equal(effects, 0);
    assert.equal(canceled, 1);
}
{
    let rpc;
    rpc = harness("http:", (_request, done, afterReply) => {
        afterReply(() => rpc.connect());
        done({ data: {}, status: "ok" });
    });
    rpc.connect();
    rpc.respond(effectRequest());
    rpc.next();
    rpc.respond({ status: "ok" });
    assert.equal(
        rpc.jobs.size,
        0,
        "ACK effect reconfiguration cannot schedule an old poll"
    );
    assert.equal(rpc.requests.at(-1).request.method, "GET");
}
console.log(
    "PASS acknowledged reload effects: retry, replay, deadline, revocation and invalid results"
);

const restartCode = ts.transpileModule(
    fs.readFileSync(
        path.join(__dirname, "../src/commands/remote-restart.ts"),
        "utf8"
    ),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(restartCode, { ecmaVersion: 5 });
const plexContext = { Date: moduleContext.Date, exports: {} };
const plexCode = ts.transpileModule(
    fs.readFileSync(
        path.join(__dirname, "../src/commands/remote-plex.ts"),
        "utf8"
    ),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(plexCode, { ecmaVersion: 5 });
vm.runInNewContext(plexCode, plexContext);
const restartContext = {
    exports: {},
    require(name) {
        if (name === "./remote-favorites-contract") {
            const exports = {};
            const code = ts.transpileModule(
                fs.readFileSync(
                    path.join(
                        __dirname,
                        "../src/commands/remote-favorites-contract.ts"
                    ),
                    "utf8"
                ),
                {
                    compilerOptions: {
                        module: ts.ModuleKind.CommonJS,
                        target: ts.ScriptTarget.ES5,
                    },
                }
            ).outputText;
            acorn.parse(code, { ecmaVersion: 5 });
            vm.runInNewContext(code, { exports });
            return exports;
        }
        if (name === "./remote-app-update")
            return { remoteAppUpdateAvailable: () => false };
        assert.equal(name, "./remote-plex");
        return plexContext.exports;
    },
};
vm.runInNewContext(restartCode, restartContext);
const executeRestart = restartContext.exports.executeRemoteRestart;
{
    const order = [];
    let locked = false;
    let effect;
    let reply;
    const play = () => {};
    const w = {
        __ottClassicPlayback: {
            checkpoint: (_snapshot, force) => order.push(["checkpoint", force]),
            snapshot: () => ({ position: 42 }),
        },
        __ottCoreBackend: () => ({
            current: () => ({
                active: () => true,
                sample: () => order.push("sample"),
            }),
            restart: () => ({
                accepted: true,
                dispatched: true,
                position: 42,
                target: "stream",
            }),
        }),
        __ottCoreTransport: { play },
        __ottParental: { needs: () => locked },
        restart: () => order.push("reload"),
        stbPlay: play,
    };
    const done = (value) => (reply = value);
    const afterReply = (value) => (effect = value);
    executeRestart(w, {}, done, afterReply);
    assert.equal(reply.data.dispatched, true);
    assert.equal(reply.data.position, 42);
    assert.equal(effect, undefined);
    for (const params of [
        [],
        null,
        { target: "other" },
        { extra: true, target: "stream" },
    ]) {
        executeRestart(w, params, done, afterReply);
        assert.equal(reply.status, "rejected");
    }
    executeRestart(w, { target: "player" }, done);
    assert.equal(reply.status, "unsupported");
    locked = true;
    executeRestart(w, { target: "player" }, done, afterReply);
    assert.equal(reply.status, "rejected");
    locked = false;
    executeRestart(w, { target: "player" }, done, afterReply);
    assert.equal(reply.data.accepted, true);
    assert.equal(reply.data.dispatched, false);
    assert.equal(order.length, 0);
    effect();
    assert.deepEqual(order, ["sample", ["checkpoint", true], "reload"]);
    order.length = 0;
    locked = true;
    effect();
    assert.equal(
        order.length,
        0,
        "settings lock changed before ACK must prevent reload"
    );
    w.stbPlay = () => {};
    executeRestart(w, {}, done, afterReply);
    assert.equal(
        reply.status,
        "unsupported",
        "legacy decoders cannot claim managed restart"
    );
}
console.log(
    "PASS remote restart: validation, owned backend, locked settings, checkpoint and truthful acceptance"
);

// Real controls use the transport's retained exact response; a lost reply never
// repeats an input or native lifecycle effect, and retirement cancels both.
for (const action of ["lifecycle", "input", "aspect"]) {
    for (const outcome of ["ack", "disabled", "expired", "policy"]) {
        let effects = 0,
            locked = false;
        const w = {
            __ottClassicScreenPort: {
                normalize: () => ({ id: "up" }),
                revision: () => 0,
            },
            __ottParental: { needs: () => locked },
            __ottRemoteLifecycle: { exit: () => effects++, platform: "tauri" },
            $: () => ({ is: () => locked }),
            captureAspectTarget: () => ({
                current: () => true,
                mode: "fit",
                savedMode: null,
                set: () => {
                    effects++;
                    return true;
                },
            }),
            keyHandler: () => effects++,
            keys: { UP: 38 },
        };
        const rpc = harness("http:", (request, done, afterReply) =>
            restartContext.exports.executeRemoteControl(
                w,
                request.action,
                request.params,
                done,
                afterReply
            )
        );
        const envelope = {
            commands: [],
            requests: [
                {
                    action,
                    expires_at: 5030,
                    id: "f".repeat(32),
                    params:
                        action === "lifecycle"
                            ? { operation: "exit_app" }
                            : action === "aspect"
                              ? {
                                    mode: "fill",
                                    operation: "set",
                                    runtime:
                                        restartContext.exports.remotePlayerInfo(
                                            w
                                        ).runtime,
                                }
                              : { key: "up" },
                },
            ],
            server_time: 5000,
        };
        rpc.connect();
        rpc.respond(envelope);
        rpc.next();
        const body = rpc.requests.at(-1).request.body;
        assert.equal(JSON.parse(body).data.dispatched, false);
        assert.equal(effects, 0);
        rpc.respond({}, 0);
        rpc.next();
        assert.equal(rpc.requests.at(-1).request.body, body);
        const pending = rpc.requests.at(-1);
        if (outcome === "disabled") rpc.connect({ enabled: false });
        if (outcome === "expired") clock += 30000;
        if (outcome === "policy") locked = true;
        pending.complete({ body: '{"status":"ok"}', status: 200 });
        assert.equal(
            effects,
            outcome === "ack" ? 1 : 0,
            action + " " + outcome
        );
        if (outcome === "ack") {
            rpc.next();
            rpc.respond(envelope);
            rpc.next();
            assert.equal(rpc.requests.at(-1).request.body, body);
            rpc.respond({ status: "ok" });
            assert.equal(
                effects,
                1,
                action + " duplicate request only replays the receipt"
            );
        }
    }
}
console.log(
    "PASS actual lifecycle/input/aspect transport: lost ACK, byte-identical retry, single dispatch, duplicate replay, disable, expiry and local policy changes"
);

// Image bytes expire independently of network progress and ordinary receipt caching.
function screenshotJob(rpc, delay) {
    const found = [...rpc.jobs].find(([, job]) => job.delay === delay);
    assert.ok(found, "expected screenshot/poll timer at " + delay);
    const [id, job] = found;
    rpc.jobs.delete(id);
    job.fn();
}
function screenshotEnvelope(id, lifetime = 30) {
    return {
        commands: [],
        requests: [
            {
                action: "screenshot",
                expires_at: clock / 1000 + lifetime,
                id,
                params: { runtime: "page-123" },
            },
        ],
        server_time: clock / 1000,
    };
}
function screenshotHarness(image = "private-image", elapsed = 0) {
    let captures = 0;
    const rpc = harness("http:", (request, done) => {
        assert.equal(request.action, "screenshot");
        captures++;
        clock += elapsed;
        done({ data: { image }, status: "ok" });
    });
    rpc.captureCount = () => captures;
    return rpc;
}
for (const reason of [
    "revoke",
    "request-expiry",
    "60-second-bound",
    "clock-rollback",
]) {
    clock = 20000000;
    const rpc = screenshotHarness();
    const id = "a".repeat(32);
    rpc.connect();
    rpc.respond(
        screenshotEnvelope(id, reason === "60-second-bound" ? 120 : 30)
    );
    screenshotJob(rpc, 0);
    const inFlight = rpc.requests.at(-1);
    assert.ok(inFlight.request.body.includes("private-image"));
    assert.equal(
        inFlight.request.screenshotControl,
        true,
        "image POST uses the no-redirect transport"
    );
    if (reason === "revoke") rpc.controller.discardScreenshots();
    else {
        if (reason === "clock-rollback") clock -= 100000;
        else clock += reason === "60-second-bound" ? 60000 : 30000;
        screenshotJob(rpc, reason === "60-second-bound" ? 60000 : 30000);
    }
    assert.equal(
        inFlight.aborted,
        true,
        reason + " cancels active image upload"
    );
    screenshotJob(rpc, 0);
    const tombstone = rpc.requests.at(-1);
    assert.equal(JSON.parse(tombstone.request.body).status, "rejected");
    assert.equal(tombstone.request.body.includes("private-image"), false);
    // A late completion cannot shift the replacement or start another poll.
    inFlight.complete({ body: '{"status":"ok"}', status: 200 });
    assert.equal(rpc.jobs.size, 0);
    rpc.respond({ status: "ok" });
    rpc.next();
    // Even a controller replay with newly extended server expiry cannot recapture.
    rpc.respond(screenshotEnvelope(id, 120));
    rpc.next();
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).status,
        "rejected"
    );
    assert.equal(
        rpc.requests.at(-1).request.body.includes("private-image"),
        false
    );
    assert.equal(rpc.captureCount(), 1, reason + " replay did not recapture");
}
{
    clock = 21000000;
    const rpc = screenshotHarness("private-image", 2000);
    rpc.connect();
    rpc.respond(screenshotEnvelope("b".repeat(32), 5));
    assert.ok(
        [...rpc.jobs.values()].some((job) => job.delay === 3000),
        "capture time consumes original request lifetime"
    );
    screenshotJob(rpc, 3000);
    screenshotJob(rpc, 0);
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).status,
        "rejected"
    );
    assert.equal(rpc.captureCount(), 1);
}
{
    clock = 22000000;
    const rpc = screenshotHarness();
    const id = "c".repeat(32);
    rpc.connect();
    rpc.respond(screenshotEnvelope(id));
    screenshotJob(rpc, 0);
    rpc.respond({ status: "ok" });
    screenshotJob(rpc, 1000);
    const poll = rpc.requests.at(-1);
    rpc.controller.discardScreenshots();
    assert.equal(
        poll.aborted,
        false,
        "revoking images does not cancel unrelated poll"
    );
    assert.equal(
        rpc.jobs.size,
        0,
        "revocation discards idle image expiry timer"
    );
    rpc.respond(screenshotEnvelope(id));
    rpc.next();
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).status,
        "rejected"
    );
    assert.equal(rpc.captureCount(), 1);
}
{
    clock = 23000000;
    const rpc = screenshotHarness();
    const id = "d".repeat(32);
    rpc.connect();
    rpc.respond(screenshotEnvelope(id));
    rpc.connect({ enabled: false });
    assert.equal(rpc.jobs.size, 0, "disconnect immediately drops image timers");
    rpc.connect();
    rpc.respond(screenshotEnvelope(id));
    rpc.next();
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).status,
        "rejected"
    );
    assert.equal(
        rpc.captureCount(),
        1,
        "same-controller reconnect preserves only tombstone"
    );
    rpc.connect({ address: "another-controller.local" });
    rpc.respond(screenshotEnvelope(id));
    assert.equal(
        rpc.captureCount(),
        2,
        "controller identity change retires old tombstones"
    );
    rpc.controller.discardScreenshots();
}
{
    clock = 24000000;
    const rpc = screenshotHarness("s".repeat(1200000));
    const first = "e".repeat(32),
        second = "f".repeat(32);
    rpc.connect();
    rpc.respond(screenshotEnvelope(first));
    screenshotJob(rpc, 0);
    rpc.respond({ status: "ok" });
    screenshotJob(rpc, 1000);
    rpc.respond(screenshotEnvelope(second));
    screenshotJob(rpc, 0);
    rpc.respond({ status: "ok" });
    screenshotJob(rpc, 1000);
    rpc.respond(screenshotEnvelope(first));
    screenshotJob(rpc, 0);
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).status,
        "rejected"
    );
    assert.equal(
        rpc.captureCount(),
        2,
        "2 MiB response-cache eviction must not recapture the oldest screenshot"
    );
    rpc.controller.discardScreenshots();
}
console.log(
    "PASS screenshot transport: timed image purge, original expiry, 60-second bound, clock rollback, revoke, in-flight abort/late callback, tombstones, eviction and reconnect identity"
);

// Use the actual Fetch transport and two HTTP listeners: no image or credential
// may arrive at a redirect destination, including a different loopback origin.
(async () => {
    const http = require("node:http");
    let sinkRequests = 0;
    const sink = http.createServer((request, response) => {
        sinkRequests++;
        request.resume();
        response.end("{}");
    });
    const listen = (server) =>
        new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await listen(sink);
    let sourceRequests = 0;
    let receivedBytes = 0;
    const origin = http.createServer((request, response) => {
        sourceRequests++;
        request.on("data", (chunk) => {
            receivedBytes += chunk.length;
        });
        request.on("end", () => {
            const code = Number(request.url.slice(1));
            response.writeHead(
                code,
                code === 200
                    ? {}
                    : {
                          Location: `http://127.0.0.1:${sink.address().port}/image`,
                      }
            );
            response.end("{}");
        });
    });
    try {
        await listen(origin);
        const send = createCommandServerTransport({
            AbortController,
            clearTimeout,
            fetch,
            Request,
            setTimeout,
        });
        const payload = JSON.stringify({ image: "A".repeat(1400000) });
        const request = {
            body: payload,
            headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/json",
            },
            method: "POST",
            screenshotControl: true,
            timeoutMs: 3000,
        };
        for (const status of [200, 301, 302, 303, 307, 308]) {
            const result = await new Promise((resolve) =>
                send(
                    {
                        ...request,
                        url: `http://127.0.0.1:${origin.address().port}/${status}`,
                    },
                    resolve
                )
            );
            assert.equal(
                result && result.status,
                status === 200 ? 200 : undefined
            );
        }
        assert.equal(sourceRequests, 6);
        assert.equal(receivedBytes, Buffer.byteLength(payload) * 6);
        assert.equal(
            sinkRequests,
            0,
            "redirect target never receives image body or bearer token"
        );
        for (const url of [
            "http://192.168.1.2/api/responses",
            "https://user:pass@example.com/api/responses",
            `http://127.0.0.1:${origin.address().port}/200#fragment`,
        ]) {
            assert.equal(
                await new Promise((resolve) =>
                    send({ ...request, url }, resolve)
                ),
                undefined
            );
        }
        assert.equal(
            sourceRequests,
            6,
            "invalid screenshot endpoints never make a request"
        );
        console.log(
            "PASS screenshot Fetch: bounded image-sized upload, all redirect statuses blocked, exact endpoint policy"
        );
    } finally {
        for (const server of [origin, sink]) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// Another document's targeted inspection must neither block this queue nor be ACKed.
{
    clock = 5000000;
    const handled = [];
    const rpc = harness(
        "http:",
        (request, done) => {
            handled.push(request.id);
            done({ data: {}, status: "ok" });
        },
        (request) =>
            request.action !== "inspect" ||
            request.params.runtime === "this-page"
    );
    rpc.connect();
    rpc.respond({
        commands: [],
        requests: [
            {
                action: "inspect",
                expires_at: 5030,
                id: "a".repeat(32),
                params: { runtime: "other-page" },
            },
            {
                action: "status",
                expires_at: 5030,
                id: "b".repeat(32),
                params: {},
            },
        ],
        server_time: 5000,
    });
    assert.deepEqual(handled, ["b".repeat(32)]);
    rpc.next();
    assert.equal(
        JSON.parse(rpc.requests.at(-1).request.body).id,
        "b".repeat(32)
    );
    rpc.respond({ status: "ok" });
    rpc.next();
    rpc.respond({
        commands: [],
        requests: [
            {
                action: "inspect",
                expires_at: 5030,
                id: "a".repeat(32),
                params: { runtime: "other-page" },
            },
        ],
        server_time: 5000,
    });
    assert.deepEqual(handled, ["b".repeat(32)]);
    rpc.next();
    assert.equal(rpc.requests.at(-1).request.method, "GET");
}
