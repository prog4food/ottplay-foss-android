const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const code = ts.transpileModule(
    fs.readFileSync(
        path.join(__dirname, "../src/plugins/diagnostics-permission.ts"),
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
const moduleContext = { exports: {} };
vm.runInNewContext(code, moduleContext);
const { createDiagnosticsPermissionStore } = moduleContext.exports;
const binding = {
    address: "https://control.example/api/webhook/commands",
    revision: "grant-1",
    token: "test_" + "x".repeat(40),
};
const plain = (value) => JSON.parse(JSON.stringify(value));
function environment() {
    const h = {
        deletes: [],
        opens: [],
        serial: 0,
        timers: new Map(),
        transactions: [],
        value: null,
    };
    h.w = {
        clearTimeout(id) {
            h.timers.delete(id);
        },
        indexedDB: {
            deleteDatabase(name) {
                assert.equal(name, "ottplay-diagnostics-permission-v1");
                const request = {};
                h.deletes.push(request);
                return request;
            },
            open(name, version) {
                assert.equal(name, "ottplay-diagnostics-permission-v1");
                assert.equal(version, 1);
                const db = {
                    close() {
                        db.closed = true;
                    },
                    closed: false,
                    createObjectStore(name) {
                        assert.equal(name, "permission");
                    },
                    objectStoreNames: { contains: () => false },
                    transaction(name, mode) {
                        assert.equal(name, "permission");
                        const actions = [];
                        const tx = {
                            abort() {
                                tx.aborted = true;
                                if (tx.onabort) tx.onabort();
                            },
                            aborted: false,
                            deliver(error = false) {
                                if (error) tx.onerror();
                                else if (!tx.aborted) {
                                    actions.forEach((action) => action());
                                    tx.oncomplete();
                                }
                            },
                            mode,
                            objectStore() {
                                return {
                                    clear() {
                                        actions.push(() => {
                                            h.value = null;
                                        });
                                    },
                                    get(key) {
                                        assert.equal(key, "trusted-controller");
                                        const read = {};
                                        actions.push(() => {
                                            read.result =
                                                h.value === null
                                                    ? undefined
                                                    : plain(h.value);
                                            read.onsuccess();
                                        });
                                        return read;
                                    },
                                    put(value, key) {
                                        assert.equal(key, "trusted-controller");
                                        actions.push(() => {
                                            h.value = plain(value);
                                        });
                                    },
                                };
                            },
                        };
                        h.transactions.push(tx);
                        return tx;
                    },
                };
                const request = { result: db };
                h.opens.push(request);
                return request;
            },
        },
        setTimeout(callback, delay) {
            const id = ++h.serial;
            h.timers.set(id, { callback, delay });
            return id;
        },
    };
    h.open = () => {
        const request = h.opens.shift();
        request.onupgradeneeded();
        request.onsuccess();
        return request;
    };
    h.complete = (error = false) => {
        const tx = h.transactions.shift();
        tx.deliver(error);
        return tx;
    };
    h.expire = () => {
        const entries = [...h.timers.values()];
        entries.forEach((timer) => {
            assert.equal(timer.delay, 3000);
            timer.callback();
        });
    };
    h.store = createDiagnosticsPermissionStore(h.w);
    return h;
}

{
    const h = environment();
    const replies = [];
    assert.equal(h.store.available(), true);
    h.store.write(binding, (error) => replies.push(error));
    h.store.read((error, value) => replies.push([error, value]));
    assert.equal(h.opens.length, 1, "operations open serially");
    h.open();
    assert.equal(
        replies.length,
        0,
        "request success is not transaction commit"
    );
    h.complete();
    assert.deepEqual(replies, [false]);
    assert.equal(h.opens.length, 1);
    h.open();
    h.complete();
    assert.deepEqual(plain(replies[1]), [false, binding]);
    replies[1][1].token = "changed";
    assert.equal(h.value.token, binding.token);
    h.store.write(null, (error) => replies.push(error));
    h.open();
    h.complete();
    assert.equal(h.value, null);
    assert.equal(h.timers.size, 0);
}
{
    const h = environment();
    const replies = [];
    h.store.write(binding, (error) => replies.push(error));
    const old = h.open();
    h.complete(true);
    old.onerror();
    assert.deepEqual(replies, [true]);
    assert.equal(h.value, null);
    assert.equal(old.result.closed, true);
    h.store.read((error, value) => replies.push([error, value]));
    const pending = h.opens.shift();
    h.expire();
    pending.onsuccess();
    assert.deepEqual(plain(replies), [true, [true, null]]);
    assert.equal(pending.result.closed, true);
    assert.equal(h.transactions.length, 0);
}
{
    const h = environment();
    h.value = plain(binding);
    const replies = [];
    h.store.write(null, (error) => replies.push(["off", error]));
    h.store.write(binding, (error) => replies.push(["on", error]));
    h.open();
    h.complete(true);
    assert.equal(
        h.deletes.length,
        1,
        "failed clear falls back to deleting only the permission database"
    );
    assert.equal(
        h.opens.length,
        0,
        "a queued grant cannot overtake failed revocation"
    );
    h.value = null;
    h.deletes.shift().onsuccess();
    assert.deepEqual(replies, [["off", false]]);
    h.open();
    h.complete();
    assert.deepEqual(replies, [
        ["off", false],
        ["on", false],
    ]);
    assert.deepEqual(h.value, binding);
}
{
    const h = environment();
    const replies = [];
    h.store.write(null, (error) => replies.push(error));
    h.open();
    h.complete(true);
    h.expire();
    assert.deepEqual(replies, [true]);
    h.deletes[0].onsuccess();
    assert.deepEqual(replies, [true], "late completion cannot resolve twice");
}
{
    const h = environment();
    const replies = [];
    for (const value of [
        { ...binding, runtimeCredential: "never persist" },
        { ...binding, token: "short" },
        { ...binding, address: "http://insecure" },
    ]) {
        h.store.write(value, (error) => replies.push(error));
    }
    assert.deepEqual(replies, [true, true, true]);
    assert.equal(h.opens.length, 0);
    h.value = { ...binding, enabled: true };
    h.store.read((error, value) => replies.push([error, value]));
    h.open();
    h.complete();
    assert.deepEqual(plain(replies[3]), [false, null]);
    const missing = createDiagnosticsPermissionStore({});
    assert.equal(missing.available(), false);
    let result;
    missing.read((error, value) => {
        result = [error, value];
    });
    assert.deepEqual(result, [true, null]);
    const denied = createDiagnosticsPermissionStore({
        get indexedDB() {
            throw new Error("access denied");
        },
    });
    assert.equal(
        denied.available(),
        true,
        "denied access cannot prove no persisted permission"
    );
    denied.read((error, value) => {
        result = [error, value];
    });
    assert.deepEqual(result, [true, null]);
}
{
    const h = environment();
    const channels = [];
    let changed = 0;
    h.w.BroadcastChannel = function (name) {
        assert.equal(name, "ottplay-diagnostics-permission-v1");
        this.messages = [];
        this.closed = false;
        this.postMessage = (value) => this.messages.push(value);
        this.close = () => {
            this.closed = true;
        };
        channels.push(this);
    };
    const release = h.store.subscribe(() => changed++);
    h.store.write(binding, (error) => assert.equal(error, false));
    h.open();
    h.complete();
    assert.deepEqual(
        channels[0].messages,
        ["changed"],
        "notifications must not contain credentials or grants"
    );
    channels[0].onmessage({ data: binding });
    assert.equal(
        changed,
        1,
        "a signal requests reread, never authorizes its payload"
    );
    release();
    assert.equal(channels[0].closed, true);
    h.store.write(null, (error) => assert.equal(error, false));
    h.open();
    h.complete();
    assert.deepEqual(channels[1].messages, ["changed"]);
    assert.equal(channels[1].closed, true);
}
console.log(
    "PASS diagnostic permission: private schema, transaction commit, queued writes, delayed callbacks, failure cleanup and revocation fallback"
);
