const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
const filename = "src/core/index.ts";
const input = process.argv.includes("--baseline")
    ? require("node:child_process").execFileSync(
          "git",
          ["show", "9371ad3:" + filename],
          { cwd: root, encoding: "utf8" }
      )
    : fs.readFileSync(path.join(root, filename), "utf8");
const ast = ts.createSourceFile(filename, input, ts.ScriptTarget.Latest, true);
const names = [
    "stbToggleTauriNativeFullscreen",
    "stbSetTauriNativeFullscreen",
    "runTauriFullscreenCall",
    "reportTauriFullscreenError",
    "publishTauriFullscreen",
];
const code = ts.transpileModule(
    ast.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) && names.includes(node.name.text)
        )
        .map((node) => node.getText(ast).replace(/^export /, ""))
        .join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(code, { ecmaVersion: 5 });
function fixture(options = {}) {
    const calls = [],
        warnings = [];
    const host = {
        __ottTauriNativeFs: options.cached ?? false,
        closeList() {
            calls.push(["close", this.__ottTauriNativeFs]);
        },
        console: {
            warn(...args) {
                warnings.push(args.map((arg) => (arg && arg.message) || arg));
            },
        },
        isListVisible: options.list ?? true,
        Promise,
    };
    host.window = host;
    vm.createContext(host);
    vm.runInContext(code, host);
    function api(name, behavior) {
        const owner = {
            invoke(command, args) {
                assert.equal(this, owner, "native invoke retains its receiver");
                calls.push([
                    name,
                    command,
                    args ? JSON.parse(JSON.stringify(args)) : null,
                ]);
                return behavior(command, args);
            },
        };
        return owner;
    }
    return { api, calls, host, warnings };
}
const results = [];
async function check(name, run) {
    try {
        await run();
        results.push({ name, status: "PASS" });
    } catch (error) {
        results.push({ error: error.stack, name, status: "FAIL" });
    }
}
async function main() {
    await check(
        "toggle invokes core immediately, honors native result and collapses list after publication",
        async () => {
            const f = fixture();
            f.host.__TAURI__ = {
                core: f.api("core", () =>
                    Promise.resolve({ fullscreen: true })
                ),
            };
            const promise = f.host.stbToggleTauriNativeFullscreen();
            assert.equal(typeof promise.then, "function");
            assert.deepEqual(f.calls, [["core", "toggle_fullscreen", null]]);
            assert.equal(await promise, undefined);
            assert.deepEqual(f.calls, [
                ["core", "toggle_fullscreen", null],
                ["close", true],
            ]);
        }
    );
    for (const mode of ["throw", "reject", "bad-result", "api-getter"])
        await check(
            "toggle core " + mode + " falls back to internals once",
            async () => {
                const f = fixture();
                const core = f.api("core", () => {
                    if (mode === "throw") throw Error("core failed");
                    if (mode === "bad-result")
                        return Object.defineProperty({}, "fullscreen", {
                            get() {
                                throw Error("bad result");
                            },
                        });
                    return Promise.reject(Error("core failed"));
                });
                f.host.__TAURI__ =
                    mode === "api-getter"
                        ? Object.defineProperty({}, "core", {
                              get() {
                                  throw Error("getter");
                              },
                          })
                        : { core };
                f.host.__TAURI_INTERNALS__ = f.api("internal", () => ({
                    fullscreen: false,
                }));
                await f.host.stbToggleTauriNativeFullscreen();
                assert.deepEqual(
                    f.calls.map((call) => call[0]),
                    mode === "api-getter" ? ["internal"] : ["core", "internal"]
                );
                assert.equal(f.host.__ottTauriNativeFs, false);
                assert.deepEqual(f.warnings, []);
            }
        );
    for (const result of [undefined, {}, { fullscreen: "true" }])
        await check(
            "older toggle response flips cached state: " +
                JSON.stringify(result),
            async () => {
                const f = fixture({ cached: true });
                f.host.__TAURI_INTERNALS__ = f.api("internal", () => result);
                await f.host.stbToggleTauriNativeFullscreen();
                assert.equal(f.host.__ottTauriNativeFs, false);
                assert.equal(f.calls.length, 1);
            }
        );
    await check(
        "toggle retries native toggle then probes and uses core set before window set",
        async () => {
            const f = fixture();
            f.host.__TAURI__ = {
                core: f.api("core", (command) =>
                    command === "toggle_fullscreen"
                        ? Promise.reject(Error("unsupported"))
                        : { fullscreen: false }
                ),
                window: {
                    getCurrentWindow() {
                        f.calls.push(["window"]);
                        return {
                            isFullscreen() {
                                f.calls.push(["probe"]);
                                return Promise.resolve(false);
                            },
                            setFullscreen() {
                                throw Error("must prefer core set");
                            },
                        };
                    },
                },
            };
            f.host.__TAURI_INTERNALS__ = f.api("internal", () =>
                Promise.reject(Error("unsupported"))
            );
            await f.host.stbToggleTauriNativeFullscreen();
            assert.deepEqual(f.calls, [
                ["core", "toggle_fullscreen", null],
                ["internal", "toggle_fullscreen", null],
                ["window"],
                ["probe"],
                ["core", "set_fullscreen", { fullscreen: true }],
                ["close", true],
            ]);
            assert.equal(
                f.host.__ottTauriNativeFs,
                true,
                "probe/set fallback uses requested state even for old response fields"
            );
        }
    );
    for (const mode of ["sync", "async", "throw", "reject", "not-boolean"])
        await check(
            "window-only probe " + mode + " retains fallback and receiver",
            async () => {
                const f = fixture({ cached: true });
                const windowApi = {
                    isFullscreen() {
                        assert.equal(this, windowApi);
                        if (mode === "throw") throw Error("probe");
                        if (mode === "reject")
                            return Promise.reject(Error("probe"));
                        if (mode === "async") return Promise.resolve(false);
                        return mode === "not-boolean" ? "false" : false;
                    },
                    setFullscreen(value) {
                        assert.equal(this, windowApi);
                        f.calls.push(["set", value]);
                        return Promise.resolve();
                    },
                };
                f.host.__TAURI__ = {
                    webviewWindow: {
                        getCurrent() {
                            return windowApi;
                        },
                    },
                    window: {
                        getCurrent() {
                            return null;
                        },
                    },
                };
                await f.host.stbToggleTauriNativeFullscreen();
                const expected = mode === "sync" || mode === "async";
                assert.equal(f.host.__ottTauriNativeFs, expected);
                assert.deepEqual(
                    f.calls,
                    expected
                        ? [
                              ["set", true],
                              ["close", true],
                          ]
                        : [["set", false]]
                );
            }
        );
    await check(
        "probe property failure does not admit a cached-state set",
        async () => {
            const f = fixture();
            const current = {
                setFullscreen() {
                    throw Error("must not set");
                },
            };
            Object.defineProperty(current, "isFullscreen", {
                get() {
                    throw Error("probe getter");
                },
            });
            f.host.__TAURI__ = {
                window: {
                    getCurrentWindow() {
                        return current;
                    },
                },
            };
            await f.host.stbToggleTauriNativeFullscreen();
            assert.deepEqual(f.calls, []);
            assert.equal(f.host.__ottTauriNativeFs, false);
            assert.deepEqual(f.warnings, [
                ["[Tauri] toggle_fullscreen failed:", "probe getter"],
            ]);
        }
    );
    await check("explicit set captures the core owner once", async () => {
        const f = fixture();
        let reads = 0;
        const owner = f.api("core", () => ({ fullscreen: true }));
        f.host.__TAURI__ = Object.defineProperty({}, "core", {
            get() {
                reads++;
                return reads === 1 ? owner : null;
            },
        });
        await f.host.stbSetTauriNativeFullscreen(true);
        assert.equal(reads, 1);
        assert.deepEqual(f.calls, [
            ["core", "set_fullscreen", { fullscreen: true }],
            ["close", true],
        ]);
    });
    await check(
        "final window-set rejection keeps the old state and reports failure",
        async () => {
            const f = fixture();
            f.host.__TAURI__ = {
                window: {
                    getCurrentWindow() {
                        return {
                            setFullscreen() {
                                return Promise.reject(Error("denied"));
                            },
                        };
                    },
                },
            };
            await f.host.stbToggleTauriNativeFullscreen();
            assert.equal(f.host.__ottTauriNativeFs, false);
            assert.deepEqual(f.calls, []);
            assert.deepEqual(f.warnings, [
                ["[Tauri] toggle_fullscreen failed:", "denied"],
            ]);
        }
    );
    await check(
        "toggle missing native paths warns once without publishing fake success",
        async () => {
            const f = fixture({ cached: true });
            await f.host.stbToggleTauriNativeFullscreen();
            assert.deepEqual(f.calls, []);
            assert.equal(f.host.__ottTauriNativeFs, true);
            assert.deepEqual(f.warnings, [
                ["[Tauri] toggle_fullscreen failed:", "no invoke path"],
            ]);
        }
    );
    for (const failing of [false, true])
        await check(
            "explicit set chooses one invoke owner, rejection never retries: " +
                failing,
            async () => {
                const f = fixture({ cached: true });
                f.host.__TAURI__ = {
                    core: f.api("core", () =>
                        failing
                            ? Promise.reject(Error("failed"))
                            : { fullscreen: false }
                    ),
                };
                f.host.__TAURI_INTERNALS__ = f.api("internal", () => {
                    throw Error("unexpected retry");
                });
                await f.host.stbSetTauriNativeFullscreen(false);
                assert.deepEqual(f.calls, [
                    ["core", "set_fullscreen", { fullscreen: false }],
                ]);
                assert.equal(f.host.__ottTauriNativeFs, failing);
                assert.equal(f.warnings.length, failing ? 1 : 0);
            }
        );
    await check(
        "explicit set recovers unavailable getter and honors older response",
        async () => {
            const f = fixture();
            f.host.__TAURI__ = Object.defineProperty({}, "core", {
                get() {
                    throw Error("getter");
                },
            });
            f.host.__TAURI_INTERNALS__ = f.api("internal", () => ({}));
            await f.host.stbSetTauriNativeFullscreen(true);
            assert.deepEqual(f.calls, [
                ["internal", "set_fullscreen", { fullscreen: true }],
                ["close", true],
            ]);
        }
    );
    for (const mode of [
        "visible-dom",
        "hidden",
        "jquery-throws",
        "close-throws",
    ])
        await check("renderer collapse tolerates " + mode, async () => {
            const f = fixture({
                list: mode === "jquery-throws" || mode === "close-throws",
            });
            f.host.__TAURI__ = {
                core: f.api("core", () => ({ fullscreen: true })),
            };
            f.host.$ = () => ({
                is() {
                    if (mode === "jquery-throws") throw Error("DOM");
                    return mode === "visible-dom";
                },
            });
            if (mode === "close-throws")
                f.host.closeList = () => {
                    f.calls.push(["close", true]);
                    throw Error("renderer");
                };
            await f.host.stbSetTauriNativeFullscreen(true);
            assert.equal(
                f.calls.filter((call) => call[0] === "close").length,
                mode === "hidden" ? 0 : 1
            );
            assert.equal(f.host.__ottTauriNativeFs, true);
            assert.deepEqual(f.warnings, []);
        });
    await check(
        "missing explicit set and throwing console still return fulfilled Promise",
        async () => {
            const f = fixture();
            f.host.console.warn = () => {
                throw Error("console");
            };
            assert.equal(
                await f.host.stbSetTauriNativeFullscreen(true),
                undefined
            );
            assert.equal(
                await f.host.stbToggleTauriNativeFullscreen(),
                undefined
            );
        }
    );
    console.log(
        JSON.stringify(
            { baseline: process.argv.includes("--baseline"), results },
            null,
            2
        )
    );
    if (results.some((result) => result.status === "FAIL"))
        process.exitCode = 1;
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
