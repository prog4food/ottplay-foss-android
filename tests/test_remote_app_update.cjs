const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const code = ts.transpileModule(
    fs.readFileSync("src/commands/remote-app-update.ts", "utf8"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
const hash = "a".repeat(64);
const calls = [];
let state = { phase: "ready", sha256: hash },
    locked = false,
    supported = true;
const native = {
    install: async (params) => {
        calls.push(["install", params]);
        return {};
    },
    prepare: async (params) => {
        calls.push(["prepare", params]);
        return { phase: "downloading" };
    },
    status: async () => state,
};
const context = {
    exports: {},
    require: () => ({ resolveNativePlugin: () => native }),
    URL,
};
vm.runInNewContext(code, context);
const w = {
    __ottParental: { needs: () => locked },
    Capacitor: {
        getPlatform: () => "android",
        isNativePlatform: () => true,
        isPluginAvailable: () => supported,
    },
};
function run(params, acknowledged = true) {
    let effect;
    return new Promise((resolve) =>
        context.exports.executeRemoteAppUpdate(
            w,
            params,
            (result) => resolve({ dispatch: () => effect && effect(), result }),
            acknowledged
                ? (f) => {
                      effect = f;
                  }
                : undefined
        )
    );
}
(async () => {
    supported = false;
    assert.equal(
        (await run({ operation: "status" })).result.status,
        "unsupported"
    );
    supported = true;
    for (const url of [
        "http://example.org/a",
        "https://user:pass@example.org/a",
        "https://example.org/a#x",
        "https://example.org/a\n",
    ]) {
        assert.equal(
            (await run({ operation: "prepare", sha256: hash, url })).result
                .status,
            "rejected"
        );
    }
    assert.equal(calls.length, 0);
    locked = true;
    assert.equal(
        (
            await run({
                operation: "prepare",
                sha256: hash,
                url: "https://example.org/a.apk",
            })
        ).result.status,
        "rejected"
    );
    assert.equal((await run({ operation: "status" })).result.status, "ok");
    locked = false;
    assert.equal(
        (
            await run({
                operation: "prepare",
                sha256: hash,
                url: "https://example.org/a.apk",
            })
        ).result.data.phase,
        "downloading"
    );
    assert.equal(calls.length, 1);
    assert.equal(
        (await run({ operation: "install", sha256: hash }, false)).result
            .status,
        "unsupported"
    );
    assert.equal(
        (await run({ operation: "install", sha256: "b".repeat(64) })).result
            .status,
        "rejected"
    );
    const admitted = await run({ operation: "install", sha256: hash });
    assert.equal(admitted.result.data.accepted, true);
    assert.equal(
        calls.length,
        1,
        "Installer must wait for the exact response ACK"
    );
    locked = true;
    admitted.dispatch();
    assert.equal(
        calls.length,
        1,
        "Revoked permission must cancel installation"
    );
    locked = false;
    (await run({ operation: "install", sha256: hash })).dispatch();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], "install");
    console.log(
        "PASS Capacitor updates: capability, URL validation, settings policy, digest binding and ACK fence"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
