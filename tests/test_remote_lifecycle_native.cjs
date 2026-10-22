const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
    path.join(root, "src/plugins/remote-lifecycle.ts"),
    "utf8"
);
const code = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES5,
    },
}).outputText;
const exports_ = {};
vm.runInNewContext(code, { exports: exports_, Promise });
const { installRemoteLifecycle: install } = exports_;
const tick = () => new Promise((resolve) => setImmediate(resolve));
let tests = 0;
async function test(name, run) {
    await run();
    tests++;
    console.log("PASS " + name);
}
function harness(w = {}, deps = {}) {
    const events = [];
    w.console = { warn: (message) => events.push(message) };
    const hook = install(w, { prepare: () => events.push("prepare"), ...deps });
    return { events, hook, w };
}
function tauriHarness(caps = { exit: true, reboot: false, restart: true }) {
    const calls = [];
    let resolve;
    let reject;
    const pending = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const invoke = function (command, args) {
        assert.equal(this, w.__TAURI__.core);
        assert.deepEqual(Object.keys(args), []);
        calls.push(command);
        return command === "lifecycle_capabilities"
            ? pending
            : Promise.resolve();
    };
    const w = { __TAURI__: { core: { invoke } } };
    return { ...harness(w), accept: () => resolve(caps), calls, reject };
}
function android() {
    return {
        getPlatform: () => "android",
        isNativePlatform: () => true,
        isPluginAvailable: (name) => name === "MobileNativeMedia",
        PluginHeaders: [
            {
                methods: [{ name: "exitApp", rtype: "promise" }],
                name: "MobileNativeMedia",
            },
        ],
    };
}

(async () => {
    await test("local native exit checkpoints before either platform tears down playback", async () => {
        const entry = ts.createSourceFile(
            "index.ts",
            fs.readFileSync(path.join(root, "src/index.ts"), "utf8"),
            ts.ScriptTarget.Latest,
            true
        );
        for (const platform of ["Capacitor", "__TAURI__"]) {
            const block = entry.statements.find(
                (node) =>
                    ts.isIfStatement(node) &&
                    node.getText(entry).includes("window.stbExit = function") &&
                    node.expression.getText(entry).includes(platform)
            );
            assert.ok(block);
            const events = [];
            const w = {
                [platform]:
                    platform === "Capacitor"
                        ? {
                              Plugins: {
                                  App: {
                                      exitApp: async () => events.push("exit"),
                                  },
                                  MobileNativeMedia: {
                                      stopBackgroundAudio: async () =>
                                          events.push("background"),
                                  },
                              },
                          }
                        : {},
                stbStop: () => events.push("stop"),
            };
            vm.runInNewContext(
                ts.transpileModule(block.getText(entry), {
                    compilerOptions: { target: ts.ScriptTarget.ES2018 },
                }).outputText,
                {
                    body_onUnload: () => events.push("checkpoint"),
                    console,
                    tauriInvoke: async () => events.push("exit"),
                    window: w,
                }
            );
            w.stbExit();
            await tick();
            assert.deepEqual(
                events,
                platform === "Capacitor"
                    ? ["checkpoint", "stop", "background", "exit"]
                    : ["checkpoint", "exit"]
            );
        }
    });
    await test("browser, browser shim and iOS never claim native exit or reboot", () => {
        for (const w of [
            {},
            {
                close() {
                    throw new Error("must not close");
                },
                ott_device: "lg/webos",
            },
            { Capacitor: {} },
            { Capacitor: { ...android(), isNativePlatform: () => false } },
            { Capacitor: { ...android(), getPlatform: () => "ios" } },
            { Capacitor: { ...android(), getPlatform: () => "other" } },
        ]) {
            const { hook, events } = harness(w, {
                mobileMedia: {
                    exitApp() {
                        throw new Error("must not exit");
                    },
                },
            });
            assert.equal(hook.exit, undefined);
            assert.equal(hook.restart, undefined);
            assert.equal(hook.reboot, undefined);
            assert.deepEqual(events, []);
        }
    });
    await test("Tauri negotiates without effects, then stable hooks prepare before native calls", async () => {
        const h = tauriHarness();
        assert.equal(h.hook.platform, "tauri");
        assert.equal(h.hook.exit, undefined);
        assert.equal(h.hook.restart, undefined);
        assert.deepEqual(h.calls, ["lifecycle_capabilities"]);
        assert.deepEqual(h.events, []);
        h.accept();
        await tick();
        const exit = h.hook.exit;
        assert.equal(h.w.__ottRemoteLifecycle, h.hook);
        h.hook.restart();
        exit();
        await tick();
        assert.equal(h.hook.exit, exit);
        assert.deepEqual(h.calls, [
            "lifecycle_capabilities",
            "restart_app",
            "exit_app",
        ]);
        assert.deepEqual(h.events, ["prepare", "prepare"]);
        assert.equal(h.hook.reboot, undefined);
    });
    await test("old shell, malformed capabilities, rejected and throwing probes remain unsupported", async () => {
        for (const caps of [
            null,
            {},
            { exit: true, restart: true },
            { exit: true, reboot: true, restart: true },
            { exit: true, other: true, reboot: false, restart: true },
        ]) {
            const h = tauriHarness(caps);
            h.accept();
            await tick();
            assert.equal(h.hook.exit, undefined);
            assert.equal(h.hook.restart, undefined);
        }
        const old = tauriHarness();
        old.reject(new Error("old shell"));
        await tick();
        assert.equal(old.hook.exit, undefined);
        const bad = harness({
            __TAURI__: {
                invoke() {
                    throw new Error("denied");
                },
            },
        });
        assert.equal(bad.hook.exit, undefined);
    });
    await test("late capability replies cannot replace a newer hook or native bridge", async () => {
        for (const replace of [
            (h) => {
                h.w.__ottRemoteLifecycle = { platform: "browser" };
            },
            (h) => {
                h.w.__TAURI__ = {};
            },
            (h) => {
                h.w.__TAURI__.core = { invoke: h.w.__TAURI__.core.invoke };
            },
        ]) {
            const h = tauriHarness();
            replace(h);
            h.accept();
            await tick();
            assert.equal(h.hook.exit, undefined);
        }
    });
    await test("captured hooks are inert after replacement and after reentrant cleanup", async () => {
        const h = tauriHarness();
        h.accept();
        await tick();
        h.w.__ottRemoteLifecycle = {};
        h.hook.exit();
        assert.deepEqual(h.calls, ["lifecycle_capabilities"]);
        assert.deepEqual(h.events, []);
        let calls = 0;
        const w = { Capacitor: android() };
        const native = harness(w, {
            mobileMedia: {
                exitApp: () => {
                    calls++;
                    return Promise.resolve();
                },
            },
            prepare: () => {
                w.__ottRemoteLifecycle = {};
            },
        });
        native.hook.exit();
        assert.equal(calls, 0);
    });
    await test("Android requires native method header, not JS fallback availability", () => {
        for (const headers of [
            undefined,
            [],
            [
                {
                    methods: [{ name: "exitApp", rtype: "promise" }],
                    name: "Other",
                },
            ],
            [{ methods: [], name: "MobileNativeMedia" }],
            [
                {
                    methods: [{ name: "exitApp", rtype: "callback" }],
                    name: "MobileNativeMedia",
                },
            ],
        ]) {
            const { hook } = harness(
                { Capacitor: { ...android(), PluginHeaders: headers } },
                { mobileMedia: { exitApp: () => Promise.resolve() } }
            );
            assert.equal(hook.exit, undefined);
        }
    });
    await test("Android calls only captured native media exit and handles failed result without fallback", async () => {
        const calls = [];
        const media = {
            exitApp() {
                assert.equal(this, media);
                calls.push("exit");
                return Promise.resolve({
                    error: "SECRET",
                    ok: false,
                    unsupported: true,
                });
            },
        };
        const h = harness(
            {
                Capacitor: android(),
                close() {
                    calls.push("close");
                },
            },
            { mobileMedia: media }
        );
        assert.equal(h.hook.platform, "android");
        h.hook.exit();
        await tick();
        assert.deepEqual(calls, ["exit"]);
        assert.deepEqual(h.events, [
            "prepare",
            "Remote lifecycle request failed.",
        ]);
        media.exitApp = () => {
            calls.push("replacement");
        };
        h.hook.exit();
        assert.deepEqual(calls, ["exit"]);
    });
    await test("Tizen uses current application with correct receiver, no discovery exit", () => {
        let exits = 0;
        const app = {
            exit() {
                assert.equal(this, app);
                exits++;
            },
        };
        const h = harness({
            tizen: { application: { getCurrentApplication: () => app } },
        });
        assert.equal(exits, 0);
        assert.equal(h.hook.platform, "tizen");
        h.hook.exit();
        assert.equal(exits, 1);
        app.exit = () => {
            exits += 100;
        };
        h.hook.exit();
        assert.equal(exits, 1);
    });
    await test("webOS requires matching non-system packaged caller identity", () => {
        for (const [identifier, appId] of [
            ["", ""],
            ["com.webos.app.browser 42", "com.webos.app.browser"],
            ["com.palm.app.browser 42", "com.palm.app.browser"],
            ["com.example.ott 42", "com.other.ott"],
            ["com.example.ott 42", "bad/id"],
        ]) {
            const h = harness({
                close() {
                    throw new Error("no close");
                },
                PalmSystem: { identifier },
                webOS: { fetchAppId: () => appId },
            });
            assert.equal(h.hook.exit, undefined);
        }
        let closes = 0;
        const w = {
            close() {
                assert.equal(this, w);
                closes++;
            },
            PalmSystem: { identifier: "com.example.ott 42" },
            webOS: { fetchAppId: () => "com.example.ott" },
        };
        const h = harness(w);
        assert.equal(closes, 0);
        assert.equal(h.hook.platform, "webos");
        h.hook.exit();
        assert.equal(closes, 1);
        w.PalmSystem.identifier = "com.webos.app.browser 42";
        h.hook.exit();
        assert.equal(closes, 1);
    });
    await test("native rejection is contained and optional persistence failure does not abort exit", async () => {
        let exits = 0;
        const h = harness(
            { Capacitor: android() },
            {
                mobileMedia: {
                    exitApp() {
                        exits++;
                        return Promise.reject(new Error("SECRET"));
                    },
                },
                prepare() {
                    throw new Error("storage failure");
                },
            }
        );
        h.hook.exit();
        await tick();
        assert.equal(exits, 1);
        assert.deepEqual(h.events, ["Remote lifecycle request failed."]);
    });
    await test("native capability scope matches allowed commands and main window", () => {
        const scope = JSON.parse(
            fs.readFileSync(
                path.join(root, "src-tauri/capabilities/remote-lifecycle.json")
            )
        );
        const normal = JSON.parse(
            fs.readFileSync(
                path.join(root, "src-tauri/capabilities/default.json")
            )
        );
        assert.deepEqual(scope.windows, ["main"]);
        assert.deepEqual(scope.remote, normal.remote);
        assert.deepEqual(scope.permissions, [
            "allow-lifecycle-capabilities",
            "allow-restart-app",
        ]);
        for (const name of ["lifecycle-capabilities", "restart-app"]) {
            const permission = fs.readFileSync(
                path.join(
                    root,
                    "src-tauri/permissions/allow-" + name + ".toml"
                ),
                "utf8"
            );
            assert.ok(
                permission.includes(
                    'commands.allow = ["' + name.replaceAll("-", "_") + '"]'
                )
            );
        }
    });
    console.log(`Remote native lifecycle: ${tests} tests passed`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
