const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const {
    embedPlayerBuildIdentity,
} = require("../scripts/player-build-identity.cjs");
let time = 1700000000000;
const modules = {};
function load(relative) {
    const file = path.resolve(relative);
    if (modules[file]) return modules[file];
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    const exports = {};
    modules[file] = exports;
    vm.runInNewContext(code.replace(/__OTTP_VERSION__/g, "1.1.53+fixture"), {
        Date: { now: () => time },
        exports,
        require: (name) => load(path.resolve(path.dirname(file), name + ".ts")),
    });
    return exports;
}
const install = load("src/plugins/remote-inspect.ts").installRemoteInspection;
const w = new JSDOM("<!doctype html><video id='video'></video>").window;
let reads = 0;
const forbidden = () => {
    throw new Error("unexpected effect");
};
w.fetch = w.setTimeout = w.__ottCoreBackend = forbidden;
w.__ottCoreBackendPeek = () => {
    reads++;
    return null;
};
w.__ottClassicPlayback = {
    snapshot: () => ({ generation: 7, phase: "idle", target: null }),
};
w.__ottClassicScreenPort = {
    revision: () => 1,
    screens: { current: () => null },
};
const api = install(w);
const runtime = load("src/commands/remote-restart.ts").remotePlayerInfo(
    w
).runtime;
function query(section, extra = {}) {
    let response;
    api.request(
        { params: { runtime, section, version: 1, ...extra } },
        (value) => {
            response = value;
        }
    );
    return JSON.parse(JSON.stringify(response));
}
const doctor = query("doctor");
assert.equal(doctor.status, "ok");
assert.equal(doctor.data.data.build.version, "1.1.53+fixture");
assert.equal(doctor.data.data.build.identity, "partial");
assert.equal(doctor.data.data.runtime, runtime);
assert.equal(doctor.data.data.media.displayEvidence, "unavailable");
assert.ok(reads > 0);
assert.equal(query("doctor", { extra: true }).data.error, "invalid_request");
assert.equal(
    query("doctor", { runtime: "another-page" }).data.runtime,
    runtime
);
assert.equal(
    query("doctor", { runtime: "another-page" }).data.error,
    "runtime_mismatch"
);
assert.equal(
    query("operation", { operation_id: "bad" }).data.error,
    "invalid_request"
);
assert.equal(
    api.accept({ action: "inspect", params: { runtime: "another-page" } }),
    false
);
assert.equal(api.accept({ action: "inspect", params: { runtime } }), true);
assert.equal(api.accept({ action: "aspect", params: { runtime } }), true);
assert.equal(
    api.accept({ action: "aspect", params: { runtime: "other-runtime" } }),
    false
);
assert.equal(api.accept({ action: "aspect", params: {} }), false);
assert.equal(api.accept({ action: "play" }), true);

const id = "a".repeat(32);
const result = () => query("operation", { operation_id: id }).data.data;
assert.equal(result().state, "unknown");
let effect;
let invoked = 0;
api.execute(
    { action: "restart", id, params: {} },
    () => {},
    (fn) => {
        effect = fn;
    },
    (_item, done, defer) => {
        defer(() => {
            invoked++;
        });
        done({ data: { accepted: true }, status: "ok" });
    }
);
assert.equal(result().state, "accepted");
assert.equal(invoked, 0);
effect();
assert.equal(result().state, "invoked");
assert.equal(result().evidence.kind, "handler_completed");
assert.equal(invoked, 1);
assert.equal(result().evidence.generation, null);

// Neither an accepted handler nor unrelated decoder progress is proof of effect.
api.execute(
    { action: "playback", id, params: { operation: "resume" } },
    () => {},
    undefined,
    (_item, done) => done({ data: { accepted: true }, status: "ok" })
);
w.__ottCoreBackendPeek = () => ({
    current: () => ({
        id: 3,
        snapshot: () => ({ phase: "playing", position: 900 }),
    }),
});
assert.equal(result().state, "invoked");
const readId = "b".repeat(32);
for (const [action, params] of [
    ["plex_queue", { op: "status" }],
    ["plex_library", { op: "list", runtime }],
    ["plex_library", { library_id: "16", op: "preview", runtime }],
    ["vportal_queue", { operation: "status" }],
    ["maintenance", { operation: "health" }],
    ["vportal_search", { query: "fixture" }],
    ["kiosk", { mode: "status" }],
    ["aspect", { operation: "get", runtime }],
]) {
    api.execute(
        { action, id: readId, params },
        () => {},
        undefined,
        (_item, done) => done({ data: {}, status: "ok" })
    );
    assert.equal(
        query("operation", { operation_id: readId }).data.data.state,
        "unknown"
    );
}
// An aspect receipt records acceptance first, then only a successful setter's
// completion. A fenced-out setter is not evidence of application or persistence.
for (const outcome of ["applied", "storage", "target", "policy"]) {
    const success = outcome === "applied";
    const aspectId = String(
        ["applied", "storage", "target", "policy"].indexOf(outcome) + 4
    ).repeat(32);
    let current = true,
        locked = false;
    w.__ottParental = { needs: () => locked };
    w.captureAspectTarget = () => ({
        current: () => current,
        mode: "fit",
        savedMode: null,
        set: () => outcome !== "storage",
    });
    let aspectEffect;
    api.execute(
        {
            action: "aspect",
            id: aspectId,
            params: { mode: "fill", operation: "set", runtime },
        },
        () => {},
        (effect) => {
            aspectEffect = effect;
        },
        (item, done, afterReply) =>
            load("src/commands/remote-restart.ts").executeRemoteControl(
                w,
                item.action,
                item.params,
                done,
                afterReply
            )
    );
    const readAspect = () =>
        query("operation", { operation_id: aspectId }).data.data;
    assert.equal(readAspect().state, "accepted");
    assert.equal(readAspect().evidence.kind, "none");
    if (outcome === "target") current = false;
    if (outcome === "policy") locked = true;
    aspectEffect();
    assert.equal(readAspect().state, success ? "invoked" : "rejected");
    assert.equal(
        readAspect().evidence.kind,
        success ? "handler_completed" : "none"
    );
}
delete w.captureAspectTarget;
delete w.__ottParental;
time += 600001;
assert.equal(result().state, "expired");
for (let i = 0; i < 130; i++) {
    api.execute(
        { action: "play", id: i.toString(16).padStart(32, "0"), params: {} },
        () => {},
        undefined,
        (_item, done) =>
            done({
                data: { error: "private URL must not enter journal" },
                status: "rejected",
            })
    );
}
assert.equal(result().state, "unknown");
assert.equal(
    query("operation", { operation_id: (129).toString(16).padStart(32, "0") })
        .data.data.state,
    "rejected"
);
assert.ok(
    !JSON.stringify(
        query("operation", {
            operation_id: (129).toString(16).padStart(32, "0"),
        })
    ).includes("private")
);
const pendingId = "d".repeat(32);
const cancel = api.execute(
    { action: "play", id: pendingId, params: {} },
    () => {},
    undefined,
    () => () => {}
);
cancel();
assert.equal(
    query("operation", { operation_id: pendingId }).data.data.state,
    "expired"
);

// Library play joins the existing receipt journal; discovery remains read-only.
api.execute(
    {
        action: "plex_library",
        id: readId,
        params: { library_id: "16", op: "play", runtime },
    },
    () => {},
    undefined,
    (_item, done) => done({ data: {}, status: "ok" })
);
assert.equal(
    query("operation", { operation_id: readId }).data.data.action,
    "plex_library"
);
assert.equal(
    api.accept({ action: "plex_library", params: { runtime: "retired-page" } }),
    false
);
assert.equal(api.accept({ action: "plex_library", params: { runtime } }), true);

// Redelivery refreshes one journal position, rather than leaving a second
// eviction entry that can delete the newer receipt. Old callbacks keep their
// own record object and cannot rewrite the refreshed operation's outcome.
{
    const journal = install(w);
    const replayId = "e".repeat(32);
    const unique = (value) => value.toString(16).padStart(32, "0");
    function receipt(operationId) {
        let value;
        journal.request(
            {
                params: {
                    operation_id: operationId,
                    runtime,
                    section: "operation",
                    version: 1,
                },
            },
            (response) => {
                value = response.data.data;
            }
        );
        return value;
    }
    function record(operationId, status = "ok") {
        journal.execute(
            { action: "play", id: operationId, params: {} },
            () => {},
            undefined,
            (_item, done) => done({ data: {}, status })
        );
    }
    let oldEffect;
    journal.execute(
        { action: "restart", id: replayId, params: {} },
        () => {},
        (effect) => {
            oldEffect = effect;
        },
        (_item, done, defer) => {
            defer(() => {});
            done({ data: {}, status: "ok" });
        }
    );
    for (let index = 0; index < 127; index++) record(unique(index));
    record(replayId, "unsupported");
    assert.equal(
        receipt(replayId).state,
        "unsupported",
        "Refreshing a full journal keeps the newest receipt"
    );
    oldEffect();
    assert.equal(
        receipt(replayId).state,
        "unsupported",
        "A stale ACK callback cannot replace the replay receipt"
    );
    assert.equal(receipt(replayId).action, "play");
    record(unique(127));
    assert.equal(receipt(replayId).state, "unsupported");
    assert.equal(
        receipt(unique(0)).state,
        "unknown",
        "Eviction removes the actual oldest distinct operation"
    );
    time += 600001;
    assert.equal(receipt(replayId).state, "expired");
    record(replayId);
    assert.equal(
        receipt(replayId).state,
        "invoked",
        "An expired ID may have a new receipt, without an observed outcome claim"
    );
    for (let index = 1000; index < 1127; index++) record(unique(index));
    assert.equal(
        receipt(replayId).state,
        "invoked",
        "Exactly 128 distinct receipts remain retained"
    );
    record(unique(1127));
    assert.equal(receipt(replayId).state, "unknown");
}

// Build identity describes the loaded code and explicitly degrades dirty sources.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ott-build-identity-"));
try {
    const git = (...args) =>
        execFileSync("git", args, { cwd: directory, stdio: "pipe" })
            .toString()
            .trim();
    git("init", "-q");
    fs.writeFileSync(path.join(directory, "source"), "first");
    git("add", "source");
    git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "Fixture"
    );
    const source = "__OTTP_SOURCE_REVISION__ __OTTP_BUILD_ID__";
    const clean = embedPlayerBuildIdentity(source, directory);
    assert.ok(clean.startsWith(git("rev-parse", "HEAD") + " bundle-"));
    assert.equal(embedPlayerBuildIdentity(source, directory), clean);
    fs.writeFileSync(path.join(directory, "source"), "edited");
    assert.ok(
        embedPlayerBuildIdentity(source, directory).startsWith(" bundle-")
    );
    assert.notEqual(
        embedPlayerBuildIdentity(source + " changed", directory).split(" ")[1],
        clean.split(" ")[1]
    );
} finally {
    fs.rmSync(directory, { force: true, recursive: true });
}
console.log(
    "remote inspection: pure snapshots, target fencing, bounded truthful receipts and loaded build identity PASS"
);

(async () => {
    let settle;
    let replies = [];
    const item = {
        action: "inspect",
        params: { runtime, section: "debug", version: 1 },
    };
    w.__ottRuntimeDebug = {
        snapshot: () =>
            new Promise((resolve) => {
                settle = resolve;
            }),
    };
    const cancel = api.execute(
        item,
        (value) => replies.push(value),
        undefined,
        forbidden
    );
    assert.equal(typeof cancel, "function");
    cancel();
    settle({ version: 1 });
    await Promise.resolve();
    assert.equal(replies.length, 0, "cancelled inspection replied");
    api.request(item, (value) => replies.push(value));
    w.__ottRuntimeDebug = { snapshot: () => Promise.resolve({}) };
    settle({ version: 1 });
    await Promise.resolve();
    assert.equal(
        replies[0].data.error,
        "unavailable",
        "retired collector was relabelled"
    );
    replies = [];
    const data = { metrics: {}, runtime, version: 1 };
    w.__ottRuntimeDebug = { snapshot: () => Promise.resolve(data) };
    api.request(item, (value) => replies.push(value));
    await Promise.resolve();
    assert.equal(replies[0].status, "ok");
    assert.equal(replies[0].data.data, data);
    for (const version of [1, 2, 3]) {
        replies = [];
        w.__ottRuntimeDebug = {
            snapshot: (requested) => {
                assert.equal(requested, version);
                return Promise.resolve({ ...data, version });
            },
        };
        api.request(
            { params: { runtime, section: "debug", version } },
            (value) => replies.push(value)
        );
        await Promise.resolve();
        assert.equal(replies[0].data.version, version);
        assert.equal(replies[0].data.data.version, version);
    }
    for (const section of ["doctor", "snapshot", "operation"])
        for (const version of [2, 3])
            assert.equal(query(section, { version }).status, "rejected");
    assert.equal(query("debug", { version: 4 }).status, "rejected");
    delete w.__ottRuntimeDebug;
    assert.equal(query("debug").status, "unsupported");
    console.log(
        "remote debug inspection: asynchronous cancellation and collector ownership PASS"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
