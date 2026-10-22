// Exercise the real post-copy audit against a native stage and incomplete/stale copies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
    stageNativeRuntime,
    auditNativeRuntimeCopy,
} = require("../scripts/native-runtime.cjs");
const root = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ottplay-native-copy-gate-")
);
const source = path.join(temporary, "source");
const copied = path.join(temporary, "App.app/public");
function cli(...args) {
    return spawnSync(
        process.execPath,
        [path.join(root, "scripts/native-runtime.cjs"), ...args],
        { encoding: "utf8", timeout: 60000 }
    );
}
try {
    fs.mkdirSync(path.join(source, "styles"), { recursive: true });
    fs.mkdirSync(path.join(source, "dist"));
    fs.writeFileSync(
        path.join(source, "index.html"),
        '<html><head><script src="/js/runtime-polyfills.js"></script></head><body><script src="./dist/player.js"></script></body></html>'
    );
    fs.writeFileSync(
        path.join(source, "styles/player.css"),
        "body { color: white; }"
    );
    fs.writeFileSync(
        path.join(source, "dist/player.js"),
        'window.playerVersion = "fixture-current";'
    );
    stageNativeRuntime(source, "capacitor");
    fs.cpSync(source, copied, { recursive: true });
    // Capacitor's generated bridge is legitimately added after player assets.
    fs.writeFileSync(
        path.join(copied, "cordova.js"),
        "/* generated bridge fixture */"
    );
    const valid = cli(
        "audit",
        copied,
        "--platform",
        "capacitor",
        "--source",
        source
    );
    assert.equal(valid.status, 0, valid.stderr || String(valid.error));
    assert(JSON.parse(valid.stdout).filesCompared > 10);
    fs.writeFileSync(path.join(copied, "stale-extra.js"), "old runtime");
    assert.throws(
        () => auditNativeRuntimeCopy(source, copied),
        /Unexpected copied native asset: stale-extra\.js/
    );
    fs.unlinkSync(path.join(copied, "stale-extra.js"));
    const manifest = path.join(copied, "native-runtime.json");
    const bytes = fs.readFileSync(manifest);
    fs.unlinkSync(manifest);
    const missing = cli("audit", copied, "--source", source);
    assert.notEqual(
        missing.status,
        0,
        "An apparently successful Xcode copy without manifest must fail"
    );
    assert.match(missing.stderr, /native-runtime\.json/);
    fs.writeFileSync(manifest, bytes);
    fs.writeFileSync(
        path.join(copied, "dist/player.js"),
        'window.playerVersion = "stale";'
    );
    assert.throws(
        () => auditNativeRuntimeCopy(source, copied),
        /Stale copied native asset: dist[/\\]player\.js/
    );
    fs.copyFileSync(
        path.join(source, "dist/player.js"),
        path.join(copied, "dist/player.js")
    );
    fs.unlinkSync(path.join(copied, "styles/player.css"));
    assert.throws(
        () => auditNativeRuntimeCopy(source, copied),
        /Missing copied native asset/
    );
    fs.copyFileSync(
        path.join(source, "styles/player.css"),
        path.join(copied, "styles/player.css")
    );
    assert.equal(cli("audit", copied, "--platform", "tauri").status, 1);
    assert(auditNativeRuntimeCopy(source, copied).files > 10);
    assert.throws(
        () => auditNativeRuntimeCopy(source, source),
        /same directory/
    );
    console.log(
        "PASS native copy gate: real runtime copy, missing manifest, stale app JS, missing CSS, stale extra JS and wrong platform"
    );
} finally {
    fs.rmSync(temporary, { force: true, recursive: true });
}
