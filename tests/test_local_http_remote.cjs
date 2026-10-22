const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { webcrypto } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
    path.join(root, "src/plugins/local-http-remote.ts"),
    "utf8"
);
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES5,
    },
}).outputText;
const context = { Date, exports: {}, Promise, Uint8Array };
vm.runInNewContext(compiled, context);
const create = context.exports.createLocalHttpRemote;
const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(overrides = {}) {
    const calls = [],
        writes = [],
        requests = [],
        delivered = [],
        timers = new Set();
    class Xhr {
        constructor() {
            requests.push(this);
            this.headers = {};
        }
        open(method, url) {
            this.method = method;
            this.url = url;
        }
        setRequestHeader(key, value) {
            this.headers[key] = value;
        }
        send() {}
        abort() {
            this.aborted = true;
            this.onabort?.();
        }
        receive(commands) {
            this.status = 200;
            this.responseText = JSON.stringify(commands);
            this.onload();
        }
    }
    const w = {
        clearInterval(fn) {
            timers.delete(fn);
        },
        crypto: webcrypto,
        handleCommand(cmd) {
            delivered.push(cmd);
        },
        setInterval(fn) {
            timers.add(fn);
            return fn;
        },
        sLocalCmdUrl:
            "http://127.0.0.1:8081/api/webhook/commands?device_id=public",
        sLocalHttpDeviceCode: "",
        sLocalHttpEnabled: 0,
        XMLHttpRequest: Xhr,
        ...overrides,
    };
    let config = async (enabled, code) => ({
        httpEnabled: enabled,
        port: enabled ? 18081 : 0,
    });
    const remote = create(
        w,
        async (...args) => {
            calls.push(args);
            return config(...args);
        },
        (enabled, code) => {
            writes.push([enabled, code]);
            w.sLocalHttpEnabled = enabled ? 1 : 0;
            w.sLocalHttpDeviceCode = code;
        }
    );
    return {
        calls,
        configure: (fn) => {
            config = fn;
        },
        delivered,
        remote,
        requests,
        timers,
        w,
        writes,
    };
}
(async () => {
    const f = fixture();
    assert.equal(f.remote.status().ready, false);
    f.remote.init();
    await settle();
    f.remote.poll();
    assert.equal(f.remote.status().ready, true);
    assert.equal(
        f.calls.length,
        0,
        "default browser settings never configure or poll HTTP"
    );
    assert.equal(f.requests.length, 0, "an old configured URL is not consent");
    assert.equal(f.w.sLocalHttpDeviceCode, "");
    await f.remote.setEnabled(true);
    const code = f.remote.status().code;
    assert.match(code, /^[a-f0-9]{64}$/);
    assert.equal(f.remote.status().port, 18081);
    assert.equal(f.requests[0].headers.Authorization, "Bearer " + code);
    assert.match(f.requests[0].url, /\?device_id=public&t=/);
    assert(!f.requests[0].url.includes(code), "secret is absent from URL");
    f.requests[0].receive([{ command: "popup_message", message: "allowed" }]);
    assert.equal(f.delivered.length, 1);
    f.remote.poll();
    const old = f.requests.at(-1);
    const disable = f.remote.setEnabled(false);
    assert.equal(
        f.remote.status().ready,
        false,
        "native drains suspended during revocation"
    );
    old.receive([{ command: "popup_message", message: "late" }]);
    assert.equal(
        f.delivered.length,
        1,
        "late response after disable is discarded immediately"
    );
    assert(old.aborted);
    await disable;
    assert.equal(
        f.remote.status().ready,
        true,
        "internal drains allowed after confirmed revocation"
    );
    assert.equal(f.remote.status().code, "");
    assert.equal(f.timers.size, 0);
    assert.equal(f.w.sLocalHttpEnabled, 0);
    await f.remote.setEnabled(true);
    assert.notEqual(
        f.remote.status().code,
        code,
        "reenabling revokes the previous code"
    );
    const other = fixture();
    await other.remote.setEnabled(true);
    assert.notEqual(
        other.remote.status().code,
        f.remote.status().code,
        "codes are device-specific"
    );
    const restart = fixture({
        sLocalHttpDeviceCode: code,
        sLocalHttpEnabled: 1,
    });
    restart.remote.init();
    await settle();
    assert.equal(
        restart.remote.status().code,
        code,
        "saved explicit opt-in survives restart"
    );
    const malformed = fixture({
        sLocalHttpDeviceCode: "public-uuid",
        sLocalHttpEnabled: 1,
    });
    malformed.remote.init();
    await settle();
    assert.equal(malformed.calls.length, 0);
    assert.equal(
        malformed.w.sLocalHttpEnabled,
        0,
        "malformed stored credentials fail closed"
    );
    const native = fixture({ Capacitor: {}, sLocalHttpEnabled: 0 });
    native.remote.init();
    await settle();
    assert.deepEqual(
        native.calls,
        [[false, ""]],
        "reload while off also shuts a surviving native listener"
    );
    const noCrypto = fixture({ crypto: undefined });
    await assert.rejects(noCrypto.remote.setEnabled(true));
    assert.equal(noCrypto.w.sLocalHttpEnabled, 0);
    assert.equal(noCrypto.requests.length, 0);
    assert(!noCrypto.calls.some((args) => args[0]), "no weak fallback code");
    const fail = fixture();
    fail.configure(async (enabled) => {
        if (enabled) throw new Error("bind failed");
        return {};
    });
    await assert.rejects(fail.remote.setEnabled(true));
    assert.equal(fail.w.sLocalHttpEnabled, 0);
    assert.equal(fail.calls.at(-1)[0], false);
    const race = fixture();
    let release;
    race.configure(async (enabled) => {
        if (enabled)
            await new Promise((resolve) => {
                release = resolve;
            });
        return { httpEnabled: enabled, port: 18081 };
    });
    const first = race.remote.setEnabled(true);
    await settle();
    const second = race.remote.setEnabled(false);
    release();
    await first;
    await second;
    assert.equal(race.remote.status().enabled, false);
    assert.equal(race.calls.at(-1)[0], false);
    assert.equal(
        race.requests.length,
        0,
        "cancelled enable never starts polling or publishes code"
    );
    const failedStop = fixture();
    failedStop.configure(async () => {
        throw new Error("bridge unavailable");
    });
    await assert.rejects(failedStop.remote.setEnabled(false));
    assert.equal(
        failedStop.remote.status().ready,
        false,
        "unconfirmed native revocation blocks dispatch"
    );
    const malformedUrl = fixture();
    const RealXhr = malformedUrl.w.XMLHttpRequest;
    malformedUrl.w.XMLHttpRequest = class extends RealXhr {
        open(method, url) {
            if (url.includes("invalid[")) throw new Error("Invalid URL");
            super.open(method, url);
        }
    };
    malformedUrl.w.sLocalCmdUrl = "http://invalid[";
    await malformedUrl.remote.setEnabled(true);
    malformedUrl.w.sLocalCmdUrl = "http://127.0.0.1/commands";
    malformedUrl.remote.poll();
    assert(
        malformedUrl.requests.at(-1).url.includes("/commands"),
        "fixing a malformed URL resumes polling"
    );
    const edited = fixture();
    await edited.remote.setEnabled(true);
    edited.w.sLocalCmdUrl = "https://new.example.invalid/commands";
    edited.requests[0].receive([{ command: "popup_message" }]);
    assert.equal(
        edited.delivered.length,
        0,
        "response from previous URL is ignored"
    );
    assert(
        !fs
            .readFileSync(path.join(root, "index.html"), "utf8")
            .includes("function pollCommands"),
        "legacy unauthenticated poller removed"
    );
    console.log(
        "PASS HTTP remote consent: default off, crypto codes, persistence, Bearer polling, revocation, races, failure, URL changes"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
