const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const pluginRoot = path.resolve(__dirname, "../src/plugins");
const modules = {
    DashExoPlayer: "dash-exo-player",
    M3UProxy: "m3u-proxy",
    MobileNativeMedia: "mobile-native-media",
    StalkerPortal: "stalker-portal",
};
const unsupported = { ok: false, unsupported: true };
const contracts = {
    DashExoPlayer: [
        [
            "getPlaybackState",
            0,
            "",
            {
                duration: 0,
                ended: false,
                ok: false,
                playing: false,
                position: 0,
                unsupported: true,
            },
        ],
        ["seekDash", 1, "", unsupported],
        ...[
            ["isDashSupported", 0],
            ["playDash", 1],
            ["pauseDash", 0],
            ["resumeDash", 0],
            ["stopDash", 0],
        ].map(([name, arity]) => [
            name,
            arity,
            `[DashExoPlayer] web fallback: ${name} unsupported`,
            unsupported,
        ]),
    ],
    M3UProxy: [
        [
            "proxyFetch",
            1,
            "[M3UProxy] native impl not available, returning empty body",
            { body: "" },
        ],
    ],
    MobileNativeMedia: [
        ["enterSystemPip", 0, "", unsupported],
        ...[
            ["getVolume", 0],
            ["setVolume", 1],
            ["playPip", 1],
            ["stopPip", 0],
            ["setFullscreen", 1],
            ["allowSleep", 0],
            ["exitApp", 0],
            ["preventSleep", 0],
            ["startBackgroundAudio", 1],
            ["pauseBackgroundAudio", 0],
            ["resumeBackgroundAudio", 1],
            ["updateBackgroundAudio", 1],
            ["stopBackgroundAudio", 0],
        ].map(([name, arity]) => [
            name,
            arity,
            `[MobileNativeMedia] web fallback: ${name} unsupported`,
            /Volume$/.test(name) ? { ...unsupported, volume: 0 } : unsupported,
        ]),
    ],
    StalkerPortal: [
        ["swopRequest", 0, "", null, "Native SWOP unavailable"],
        [
            "httpRequest",
            0,
            "",
            null,
            "[StalkerPortal] native HTTP unavailable (web fallback)",
        ],
        [
            "portalRequest",
            1,
            "",
            null,
            "[StalkerPortal] native plugin unavailable (web fallback)",
        ],
    ],
};

function runtime(capacitor) {
    const warnings = [];
    const sandbox = {
        console: { warn: (message) => warnings.push(message) },
        Error,
        Promise,
        window: capacitor === undefined ? {} : { Capacitor: capacitor },
    };
    const context = vm.createContext(sandbox);
    const cache = new Map();
    function load(name) {
        const file = path.resolve(pluginRoot, name + ".ts");
        assert.equal(path.dirname(file), pluginRoot);
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText;
        const execute = vm.runInContext(
            "(function (require, module, exports) {\n" + code + "\n})",
            context,
            { filename: file }
        );
        execute(
            (specifier) => {
                assert.ok(specifier.startsWith("./"));
                return load(specifier.slice(2));
            },
            module,
            module.exports
        );
        return module.exports;
    }
    const plugins = {};
    for (const [name, file] of Object.entries(modules))
        plugins[name] = load(file)[name];
    return {
        helper: load("web-fallback").nativeWebFallback,
        plugins,
        sandbox,
        warnings,
    };
}

function invoke(plugin, name, options) {
    let result;
    assert.doesNotThrow(() => {
        result = plugin[name](options);
    }, name + " must reject through its Promise instead of throwing");
    assert.ok(result instanceof Promise, name + " returns a Promise");
    return result;
}

async function checkFallbacks(capacitor) {
    const { plugins, warnings } = runtime(capacitor);
    const options = new Proxy(
        {},
        {
            get() {
                throw new Error("Fallback unexpectedly read native options");
            },
        }
    );
    let methods = 0;
    for (const [pluginName, specs] of Object.entries(contracts)) {
        const plugin = plugins[pluginName];
        assert.equal(plugin.constructor.name, pluginName + "Web");
        assert.deepEqual(
            Object.getOwnPropertyNames(Object.getPrototypeOf(plugin))
                .filter((name) => name !== "constructor")
                .sort(),
            specs.map(([name]) => name).sort()
        );
        for (const [name, arity, warning, expected, error] of specs) {
            methods++;
            assert.equal(plugin[name].length, arity, pluginName + "." + name);
            assert.equal(
                plugin[name].name,
                "",
                "ES5 method name: " + pluginName + "." + name
            );
            warnings.length = 0;
            const promise = invoke(plugin, name, options);
            assert.deepEqual(
                warnings,
                warning ? [warning] : [],
                name + " must warn immediately before returning"
            );
            const order = [];
            const reaction = promise.then(
                () => order.push("result"),
                () => order.push("error")
            );
            Promise.resolve().then(() => order.push("next microtask"));
            assert.deepEqual(
                order,
                [],
                "Promise reactions remain asynchronous"
            );
            if (error) {
                await assert.rejects(promise, {
                    message: error,
                    name: "Error",
                });
            } else {
                const value = await promise;
                assert.deepEqual(JSON.parse(JSON.stringify(value)), expected);
                const next = await invoke(plugin, name, options);
                assert.notEqual(
                    value,
                    next,
                    name + " returns fresh result objects"
                );
            }
            await reaction;
            assert.deepEqual(order, [
                error ? "error" : "result",
                "next microtask",
            ]);
        }
    }
    assert.equal(methods, 25);
}

async function checkErrors() {
    for (const mode of ["call", "getter"]) {
        const state = runtime();
        const failure = new Error("Warning " + mode + " failed");
        if (mode === "getter") {
            Object.defineProperty(state.sandbox.console, "warn", {
                get() {
                    throw failure;
                },
            });
        } else {
            state.sandbox.console.warn = () => {
                throw failure;
            };
        }
        for (const [pluginName, specs] of Object.entries(contracts)) {
            for (const [name, , warning] of specs) {
                if (!warning) continue;
                await assert.rejects(
                    invoke(state.plugins[pluginName], name, {}),
                    (error) => error === failure
                );
            }
        }
    }
    const state = runtime();
    const failure = new Error("Error constructor failed");
    state.sandbox.Error = function () {
        throw failure;
    };
    for (const [name] of contracts.StalkerPortal) {
        await assert.rejects(
            invoke(state.plugins.StalkerPortal, name, {}),
            (error) => error === failure
        );
    }
}

async function checkPromiseBoundary() {
    const { helper } = runtime();
    const order = [];
    const value = {};
    const result = helper(() => {
        order.push("action");
        return value;
    });
    order.push("returned");
    result.then(() => order.push("result"));
    Promise.resolve().then(() => order.push("next microtask"));
    assert.deepEqual(order, ["action", "returned"]);
    assert.equal(await result, value);
    assert.deepEqual(order, ["action", "returned", "result", "next microtask"]);

    const adopted = helper(() => ({
        get then() {
            order.push("then getter");
            return (resolve) => {
                order.push("then call");
                resolve(value);
            };
        },
    }));
    assert.equal(order.at(-1), "then getter");
    assert.equal(await adopted, value);
    assert.equal(order.at(-1), "then call");
    const failure = new Error("Fallback failed");
    await assert.rejects(
        helper(() => {
            throw failure;
        }),
        (error) => error === failure
    );
    await assert.rejects(
        helper(() => ({
            get then() {
                throw failure;
            },
        })),
        (error) => error === failure
    );
}

async function checkNativeSelection() {
    const registered = {};
    for (const name of Object.keys(modules)) registered[name] = { name };
    const direct = runtime({
        Plugins: registered,
        registerPlugin() {
            assert.fail("An existing native proxy must be reused");
        },
    });
    for (const name of Object.keys(modules))
        assert.equal(direct.plugins[name], registered[name]);
    assert.deepEqual(direct.warnings, []);

    const factories = {};
    const capacitor = {
        registerPlugin(name, options) {
            assert.equal(this, capacitor);
            assert.equal(
                factories[name],
                undefined,
                "Register each plugin once"
            );
            factories[name] = options.web;
            return registered[name];
        },
    };
    const dynamic = runtime(capacitor);
    for (const name of Object.keys(modules)) {
        assert.equal(dynamic.plugins[name], registered[name]);
        assert.equal(typeof factories[name], "function");
        const fallback = factories[name]();
        const [method, , , expected, error] = contracts[name][0];
        const promise = invoke(fallback, method, {});
        if (error) await assert.rejects(promise, { message: error });
        else
            assert.deepEqual(
                JSON.parse(JSON.stringify(await promise)),
                expected
            );
    }
}

async function main() {
    await checkFallbacks();
    await checkFallbacks({ Plugins: {} });
    await checkErrors();
    await checkPromiseBoundary();
    await checkNativeSelection();
    console.log(
        "OK: 25 native fallback contracts, immediate effects, Promise rejection/adoption/order, and native proxy selection"
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
