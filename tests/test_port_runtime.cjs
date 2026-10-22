const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function compile(file) {
    return ts
        .transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^import .*\n/gm, "")
        .replace(/^export /gm, "");
}
function context(capacitor) {
    const c = vm.createContext({ Capacitor: capacitor, console });
    vm.runInContext("var window = this;", c);
    return c;
}
async function run() {
    const old = context();
    vm.runInContext(
        "Object.assign = undefined; Number.parseInt = undefined; Number.parseFloat = undefined; Number.isFinite = undefined; Number.isNaN = undefined; Number.isInteger = undefined; String.prototype.includes = undefined;",
        old
    );
    vm.runInContext(
        fs.readFileSync(path.join(root, "js/runtime-polyfills.js"), "utf8"),
        old
    );
    vm.runInContext(compile("src/polyfills/index.ts"), old);
    assert.equal(vm.runInContext('Number.parseInt("42", 10)', old), 42);
    assert.equal(vm.runInContext('Number.isFinite("42")', old), false);
    assert.equal(vm.runInContext("Number.isInteger(1.5)", old), false);
    assert.equal(vm.runInContext("Number.isNaN(NaN)", old), true);
    assert.equal(
        vm.runInContext('"BBC World".toLowerCase().includes("world")', old),
        true
    );
    assert.equal(
        vm.runInContext("Object.assign({}, null, {x:1}, {x:2}).x", old),
        2
    );
    assert.throws(() => vm.runInContext("Object.assign(null, {})", old), {
        name: "TypeError",
    });
    // The second application must not replace the timezone the user selected.
    assert.equal(
        vm.runInContext(
            "Date.setTimezoneOffset(-180); applyPolyfills(); Date.getTimezoneOffset()",
            old
        ),
        -180
    );

    const files = [
        "native-bridge",
        "web-fallback",
        "mobile-native-media",
        "dash-exo-player",
    ];
    const methods = [];
    const media = {
        setVolume: async (opts) => {
            methods.push(["setVolume", opts.volume]);
            return { ok: true, volume: opts.volume };
        },
    };
    const dash = { isDashSupported: async () => ({ ok: true }) };
    const registered = [];
    const cap = {
        registerPlugin(name, options) {
            registered.push(name);
            assert.equal(typeof options.web, "function");
            return name === "MobileNativeMedia" ? media : dash;
        },
    };
    const native = context(cap);
    files.forEach((file) =>
        vm.runInContext(compile("src/plugins/" + file + ".ts"), native)
    );
    assert.deepEqual(registered, ["MobileNativeMedia", "DashExoPlayer"]);
    await native.MobileNativeMedia.setVolume({ volume: 38 });
    assert.deepEqual(methods, [["setVolume", 38]]);
    assert.equal((await native.DashExoPlayer.isDashSupported()).ok, true);
    const existing = context({
        Plugins: { DashExoPlayer: dash, MobileNativeMedia: media },
        registerPlugin() {
            throw Error("duplicate registration");
        },
    });
    files.forEach((file) =>
        vm.runInContext(compile("src/plugins/" + file + ".ts"), existing)
    );
    assert.equal(existing.MobileNativeMedia, media);
    const web = context();
    files.forEach((file) =>
        vm.runInContext(compile("src/plugins/" + file + ".ts"), web)
    );
    assert.equal((await web.MobileNativeMedia.getVolume()).unsupported, true);
    assert.equal((await web.DashExoPlayer.isDashSupported()).unsupported, true);
    console.log(
        "OK: runtime API compatibility and typed native plugin registration"
    );
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
