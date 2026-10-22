const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const ts = require("typescript");
const {
    assembleClassic,
    CLASSIC_MODULES,
} = require("../scripts/classic-bundle.cjs");
const { optimizeClassic } = require("../scripts/classic-optimizer.cjs");
const {
    CLASSIC_PLAYER_NAME_POLICY,
} = require("../scripts/classic-function-names.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-linker-"));
function testInventoryWithoutCompiler() {
    const isolated = { exports: {} };
    vm.runInNewContext(
        fs.readFileSync(
            path.join(__dirname, "../scripts/classic-bundle.cjs"),
            "utf8"
        ),
        {
            module: isolated,
            require(name) {
                assert.notEqual(
                    name,
                    "typescript",
                    "Inventory must not load the compiler"
                );
                return require(name);
            },
        }
    );
    assert.deepEqual(
        Object.keys(isolated.exports.CLASSIC_PROVIDER_BUNDLES),
        Object.keys(
            require("../scripts/classic-bundle.cjs").CLASSIC_PROVIDER_BUNDLES
        )
    );
    assert.throws(
        () => isolated.exports.assembleClassic(root, []),
        /Inventory must not load the compiler/,
        "Actual assembly must still load the compiler"
    );
}
function write(name, source) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
}

function compile(source) {
    return ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            removeComments: true,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}

function helperCount(source, name) {
    return acorn
        .parse(source, { ecmaVersion: 5 })
        .body.filter(
            (statement) =>
                statement.type === "VariableDeclaration" &&
                statement.declarations.some(
                    (declaration) => declaration.id.name === name
                )
        ).length;
}

async function testNativeHttpBoundary() {
    const moduleFile = "build/plugins/native-http.js";
    write(
        moduleFile,
        compile(
            fs.readFileSync(
                path.join(__dirname, "../src/plugins/native-http.ts"),
                "utf8"
            )
        )
    );
    write(
        "native-http-consumer.js",
        'import "./build/plugins/native-http"; ' +
            "window.installCapacitorHttpTransport($, http); " +
            "installTauriHttpTransport(tauriJquery, invoke);"
    );
    const linked = assembleClassic(root, [
        moduleFile,
        "native-http-consumer.js",
    ]);
    const optimized = await optimizeClassic(linked, CLASSIC_PLAYER_NAME_POLICY);
    for (const source of [linked, optimized.code]) {
        const registrations = [];
        const tauriRegistrations = [];
        const requests = [];
        const context = vm.createContext({
            $: { ajaxTransport: (...args) => registrations.push(args) },
            Capacitor: {
                getPlatform: () => "ios",
                isNativePlatform: () => true,
            },
            http: {
                cancelHttpRequest: () => Promise.resolve(),
                httpRequest: (args) => {
                    requests.push(args);
                    return Promise.resolve({
                        body: "playlist",
                        headers: "Content-Type: text/plain\r\n",
                        status: 200,
                        statusText: "OK",
                    });
                },
            },
            invoke: () => Promise.resolve(),
            location: { origin: "capacitor://localhost" },
            nativeHttpSequence: 700,
            tauriJquery: {
                ajaxTransport: (...args) => tauriRegistrations.push(args),
            },
            URL,
        });
        context.window = context;
        acorn.parse(source, { ecmaVersion: 5 });
        vm.runInContext(source, context);
        assert.equal(typeof context.installCapacitorHttpTransport, "function");
        assert.equal(typeof context.installTauriHttpTransport, "function");
        assert.equal(context.nativeHttpSequence, 700);
        for (const name of [
            "nativeHttpRemoteUrl",
            "nativeHttpFormField",
            "nativeHttpJsonpConverter",
            "installNativeHttpTransport",
            "installNativeSwopTransport",
            "nativeHttpInstallTauri",
            "nativeHttpInstallCapacitor",
        ])
            assert.equal(context[name], undefined, name + " must stay private");
        assert.equal(registrations.length, 2);
        assert.equal(tauriRegistrations.length, 2);
        const transport = registrations[0][1]({
            contents: {},
            dataTypes: ["text"],
            type: "GET",
            url: "https://source.example/playlist.m3u",
        });
        const response = await new Promise((resolve) =>
            transport.send({}, (...args) => resolve(args))
        );
        assert.match(requests[0].requestId, /^http-\d+-1$/);
        assert.equal(response[0], 200);
        assert.equal(response[2].text, "playlist");
    }
}

// Exercise Windows path identities with the real compiler on every CI host.
// TypeScript's SourceFile paths use '/', even when root file names use '\\'.
function windowsLinker(files) {
    const normalize = (file) => path.win32.resolve(file).replace(/\\/g, "/");
    const contents = new Map(
        Object.entries(files).map(([file, text]) => [normalize(file), text])
    );
    const observed = { roots: [], sources: [] };
    function compilerHost(options) {
        const host = ts.createCompilerHost(options);
        host.getCurrentDirectory = () => "C:/checkout";
        host.getCanonicalFileName = (file) => file.toLowerCase();
        host.useCaseSensitiveFileNames = () => false;
        host.fileExists = (file) => contents.has(normalize(file));
        host.readFile = (file) => contents.get(normalize(file));
        host.directoryExists = (directory) =>
            Array.from(contents.keys()).some((file) =>
                file.startsWith(normalize(directory) + "/")
            );
        host.getSourceFile = (file, languageVersion) => {
            const text = host.readFile(file);
            if (text === undefined) return undefined;
            const source = ts.createSourceFile(
                file,
                text,
                languageVersion,
                true
            );
            observed.sources.push(source.fileName);
            return source;
        };
        return host;
    }
    const compiler = {
        ...ts,
        createCompilerHost: compilerHost,
        createProgram(files, options) {
            observed.roots.push(...files);
            return ts.createProgram(files, options, compilerHost(options));
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(
        fs.readFileSync(
            path.join(__dirname, "../scripts/classic-bundle.cjs"),
            "utf8"
        ),
        {
            module,
            require(name) {
                if (name === "node:path") return path.win32;
                if (name === "node:fs")
                    return {
                        existsSync: (file) => contents.has(normalize(file)),
                    };
                if (name === "typescript") return compiler;
                throw new Error(
                    "Unexpected classic linker dependency: " + name
                );
            },
        }
    );
    return { assemble: module.exports.assembleClassic, observed };
}

async function testWindowsPaths() {
    const windowsRoot = "C:\\checkout";
    const manifest = "build/compatibility/legacy-names.js";
    const privateFile = "build/debug/playback-debug.js";
    const modules = [manifest, "before.js", "dep.js", privateFile, "entry.js"];
    const files = {
        [path.win32.join(windowsRoot, manifest)]:
            'var legacyPlayerBindings = [["channelName", "chName"], ["getChannel", "getCh"]];',
        [path.win32.join(windowsRoot, "before.js")]: "var events = ['before'];",
        [path.win32.join(windowsRoot, "dep.js")]:
            'export var channelName = "first"; export function getChannel() { return channelName; }',
        [path.win32.join(windowsRoot, privateFile)]:
            "var privateState = 3; function privateRead() { return privateState; } " +
            "window.__ottDebug = { read: privateRead }; events.push('private');",
        [path.win32.join(windowsRoot, "entry.js")]:
            'import { channelName as currentName, getChannel } from "./dep"; ' +
            "export function publicRead(channelName) { return [getChannel(), currentName, channelName]; } " +
            "events.push('after');",
    };
    const linker = windowsLinker(files);
    const linked = linker.assemble(windowsRoot, modules);
    assert(
        linker.observed.roots.every((file) =>
            file.startsWith("C:\\checkout\\")
        ),
        "The compiler receives Windows-native root paths"
    );
    assert(
        linker.observed.sources.every((file) =>
            file.startsWith("C:/checkout/")
        ),
        "The real compiler normalizes source-file paths to forward slashes"
    );
    const optimized = await optimizeClassic(linked);
    for (const source of [linked, optimized.code]) {
        acorn.parse(source, { ecmaVersion: 5 });
        const context = vm.createContext({ privateState: 100 });
        context.window = context;
        vm.runInContext(source, context);
        assert.equal(
            typeof context.getCh,
            "function",
            "Keep the provider's legacy global ABI on Windows"
        );
        assert.equal(context.getChannel, undefined);
        assert.equal(context.chName, "first");
        assert.deepEqual(Array.from(context.publicRead("local")), [
            "first",
            "first",
            "local",
        ]);
        context.chName = "changed by provider";
        assert.deepEqual(Array.from(context.publicRead("local")), [
            "changed by provider",
            "changed by provider",
            "local",
        ]);
        vm.runInContext(
            'function getCh() { return "provider hook"; }',
            context
        );
        assert.deepEqual(Array.from(context.publicRead("local")), [
            "provider hook",
            "changed by provider",
            "local",
        ]);
        assert.equal(
            context.privateState,
            100,
            "The Windows build isolates debug state"
        );
        assert.equal(context.privateRead, undefined);
        assert.equal(context.__ottDebug.read(), 3);
        assert.deepEqual(Array.from(context.events), [
            "before",
            "private",
            "after",
        ]);
    }
    for (const reference of ["privateState", "window.privateState"]) {
        const leakingFiles = {
            ...files,
            [path.win32.join(windowsRoot, "entry.js")]:
                "var leaked = " + reference + ";",
        };
        assert.throws(
            () => windowsLinker(leakingFiles).assemble(windowsRoot, modules),
            /reference to private classic binding/,
            "Windows cannot bypass private-boundary validation"
        );
    }
}

async function testPrivateBoundary() {
    const privateFile = "build/debug/playback-debug.js";
    write("private-before.js", "var events = ['before']; var liveValue = 2;");
    write(
        privateFile,
        `
        var privateState = 3;
        var moduleReceiver = this;
        function privateRead(value) { return privateState + liveValue + value; }
        function unusedPrivateFunction() { return 'unreachable'; }
        window.__ottDebug = {
            read: privateRead,
            change: function(value) { privateState = value; },
            receiver: moduleReceiver
        };
        events.push('private');
    `
    );
    write(
        "private-after.js",
        "events.push('after'); var publicCallback = window.__ottDebug.read;"
    );
    const linked = assembleClassic(root, [
        "private-before.js",
        privateFile,
        "private-after.js",
    ]);
    const optimized = await optimizeClassic(linked);
    for (const source of [linked, optimized.code]) {
        acorn.parse(source, { ecmaVersion: 5 });
        const context = vm.createContext({ privateState: 100 });
        context.window = context;
        vm.runInContext(source, context);
        assert.deepEqual(Array.from(context.events), [
            "before",
            "private",
            "after",
        ]);
        assert.equal(
            context.__ottDebug.receiver,
            vm.runInContext("this", context)
        );
        assert.equal(
            context.privateState,
            100,
            "An existing global cannot overwrite private state"
        );
        assert.equal(context.privateRead, undefined);
        assert.equal(context.unusedPrivateFunction, undefined);
        assert.equal(context.publicCallback(1), 6);
        assert.equal(context.publicCallback.name, "privateRead");
        assert.equal(context.publicCallback.length, 1);
        context.liveValue = 10;
        context.__ottDebug.change(5);
        assert.equal(
            context.publicCallback(2),
            17,
            "Public callbacks retain private state and live global reads"
        );
        context.__ottDebug.read = () => 99;
        assert.equal(
            context.__ottDebug.read(),
            99,
            "Public API properties remain replaceable"
        );
        assert.equal(context.publicCallback(2), 17);
    }
    assert(
        !optimized.code.includes("unusedPrivateFunction"),
        "The real optimizer can eliminate an unreferenced private function"
    );
    for (const reference of [
        "var leaked = privateState;",
        "var leaked = window.privateState;",
        "var leaked = window['privateState'];",
        "import { privateState } from './build/debug/playback-debug';",
    ]) {
        write("private-leak.js", reference);
        assert.throws(
            () => assembleClassic(root, [privateFile, "private-leak.js"]),
            /private classic/
        );
    }
    write(
        "private-shadow.js",
        "function ownState(privateState) { return privateState; }" +
            "function ownWindow(window) { return window.privateState; }"
    );
    assert.doesNotThrow(() =>
        assembleClassic(root, [privateFile, "private-shadow.js"])
    );
    for (const invalid of [
        "export var leaked = 1;",
        "export { privateState }; var privateState = 1;",
        "export {}; var privateState = 1;",
        "import { video } from '../../dep';",
    ]) {
        write(privateFile, invalid);
        assert.throws(
            () => assembleClassic(root, ["dep.js", privateFile]),
            /private classic module must publish window properties/
        );
    }
    write(
        privateFile,
        `
        if (true) { var branchState = 1; }
        for (var loopState = 0; loopState < 1; loopState++) {}
        window.__ottDebug = { value: branchState + loopState };
    `
    );
    for (const reference of [
        "branchState",
        "loopState",
        "window.branchState",
        "window['loopState']",
    ]) {
        write("private-hoisted-leak.js", "var leaked = " + reference + ";");
        assert.throws(
            () =>
                assembleClassic(root, [privateFile, "private-hoisted-leak.js"]),
            /reference to private classic binding/
        );
    }
    write(
        privateFile,
        compile(`
        async function privateAwait(value) { return await value; }
        window.__ottDebug = { wait: privateAwait };
    `)
    );
    write(
        "public-async.js",
        compile(
            "export async function publicAwait(value) { return await value; }"
        )
    );
    const asyncSource = assembleClassic(root, [privateFile, "public-async.js"]);
    assert.equal(
        helperCount(asyncSource, "__awaiter"),
        1,
        "A private helper must not replace the global helper initialization"
    );
    const asyncContext = vm.createContext({});
    asyncContext.window = asyncContext;
    vm.runInContext(asyncSource, asyncContext);
    assert.equal(await asyncContext.__ottDebug.wait(Promise.resolve(7)), 7);
    assert.equal(await asyncContext.publicAwait(Promise.resolve(9)), 9);
}

async function testHelpers() {
    const first = compile(`
        export async function firstAsync(value: unknown, events: string[]) {
            events.push("start");
            const result = await value;
            events.push("resolved");
            return Number(result) + 1;
        }
    `);
    const second = compile(`
        export async function secondAsync(value: unknown, events: string[]) {
            try { return await value; }
            catch (error) { events.push(error.message); return "caught"; }
            finally { events.push("finally"); }
        }
        export async function rejectAsync() {
            await 1;
            throw new Error("failure after await");
        }
    `);
    write("before-helpers.js", "var beforeHelpers = true;");
    write("async-a.js", first);
    write("async-b.js", second);
    write(
        "local-helpers.js",
        `export function localHelper(__awaiter) { return __awaiter(7); }
        export function nestedHelper() {
            var __generator = function () { return 8; };
            return __generator();
        }
        export function helperProperty() {
            var object = { __awaiter: function () { return 9; } };
            return object.__awaiter();
        }`
    );
    const modules = [
        "before-helpers.js",
        "async-a.js",
        "async-b.js",
        "local-helpers.js",
    ];
    const linked = assembleClassic(root, modules);
    assert.equal(helperCount(linked, "__awaiter"), 1);
    assert.equal(helperCount(linked, "__generator"), 1);
    assert.ok(
        linked.indexOf("var beforeHelpers") < linked.indexOf("var __awaiter")
    );
    assert.ok(
        linked.indexOf("var __awaiter") < linked.indexOf("function firstAsync")
    );
    write("already-linked.js", linked);
    assert.equal(
        assembleClassic(root, ["already-linked.js"]).trim(),
        linked.trim(),
        "Linking an already-linked bundle does not change helper definitions"
    );

    // A pre-existing global implementation still wins the compiler's fallback.
    const externalAwaiter = function () {
        return "external implementation";
    };
    const externalGenerator = function () {
        return "external generator";
    };
    const external = vm.createContext({
        __awaiter: externalAwaiter,
        __generator: externalGenerator,
    });
    vm.runInContext(linked, external);
    assert.equal(external.__awaiter, externalAwaiter);
    assert.equal(external.__generator, externalGenerator);
    assert.equal(external.firstAsync(1, []), "external implementation");
    assert.equal(
        external.localHelper((value) => value + 1),
        8
    );
    assert.equal(external.nestedHelper(), 8);
    assert.equal(external.helperProperty(), 9);

    const resetHelpers = JSON.stringify(
        "__awaiter = null; __generator = null;"
    );
    for (const evaluate of [
        "eval(" + resetHelpers + ");",
        "(eval)(" + resetHelpers + ");",
        "(0, eval)(" + resetHelpers + ");",
        "var evaluateAlias = eval; evaluateAlias(" + resetHelpers + ");",
        "new Function(" + resetHelpers + ")();",
        "var constructAlias = Function; constructAlias(" +
            resetHelpers +
            ")();",
    ]) {
        write("dynamic-helpers.js", evaluate);
        const dynamic = assembleClassic(root, [
            "async-a.js",
            "dynamic-helpers.js",
            "async-b.js",
        ]);
        assert.equal(helperCount(dynamic, "__awaiter"), 2);
        assert.equal(helperCount(dynamic, "__generator"), 2);
        const dynamicContext = vm.createContext({});
        vm.runInContext(dynamic, dynamicContext);
        const events = [];
        assert.equal(await dynamicContext.secondAsync(23, events), 23);
        assert.deepEqual(events, ["finally"]);
    }
    write(
        "shadowed-eval.js",
        "function callLocalEval(eval, Function) { return eval('local') + Function('local'); }" +
            "var propertyKeys = { eval: 1, Function: 2 };"
    );
    const shadowedEval = assembleClassic(root, [
        "async-a.js",
        "shadowed-eval.js",
        "async-b.js",
    ]);
    assert.equal(helperCount(shadowedEval, "__awaiter"), 1);
    assert.equal(helperCount(shadowedEval, "__generator"), 1);

    // A different compiler/helper implementation must not be mistaken for an
    // identical definition. Preserve it when no matching duplicates exist.
    const changed = second.replace("P = Promise", "P = AlternatePromise");
    assert.notEqual(changed, second);
    write("different-helper.js", changed);
    const different = assembleClassic(root, [
        "async-a.js",
        "different-helper.js",
    ]);
    assert.equal(helperCount(different, "__awaiter"), 2);
    assert.ok(different.includes("AlternatePromise"));
    assert.throws(
        () =>
            assembleClassic(root, [
                "async-a.js",
                "async-b.js",
                "different-helper.js",
            ]),
        /conflicting classic TypeScript helper: __awaiter/
    );
    for (const mutation of [
        "__awaiter = function () {};",
        "function __awaiter() {}",
        "window.__awaiter = null;",
        'globalThis["__generator"] = null;',
        "function resetHelper() { __generator = null; }",
    ]) {
        write("helper-mutation.js", mutation);
        assert.throws(
            () =>
                assembleClassic(root, [
                    "async-a.js",
                    "helper-mutation.js",
                    "async-b.js",
                ]),
            /conflicting classic TypeScript helper/,
            mutation
        );
    }
    write("unrecognized-a.js", "var __awaiter = function () { return 1; };");
    write("unrecognized-b.js", "var __awaiter = function () { return 2; };");
    const unrecognized = assembleClassic(root, [
        "unrecognized-a.js",
        "unrecognized-b.js",
    ]);
    assert.equal(helperCount(unrecognized, "__awaiter"), 2);
    const unknownContext = vm.createContext({});
    vm.runInContext(unrecognized, unknownContext);
    assert.equal(unknownContext.__awaiter(), 2);

    // Use the shipped polyfills, not the host's Promise/Symbol, to execute
    // downlevel async functions in a separate old-engine-like global scope.
    const legacy = vm.createContext({
        clearTimeout,
        Iterator: undefined,
        Promise: undefined,
        Symbol: undefined,
        setTimeout,
    });
    legacy.self = legacy;
    assert.equal(vm.runInContext("typeof Promise", legacy), "undefined");
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, "../js/runtime-polyfills.js"),
            "utf8"
        ),
        legacy
    );
    assert.equal(vm.runInContext("typeof Promise", legacy), "function");
    assert.equal(vm.runInContext("typeof Symbol", legacy), "function");
    vm.runInContext(linked, legacy);
    const events = [];
    const result = legacy.firstAsync(
        {
            then(resolve) {
                resolve(41);
            },
        },
        events
    );
    assert.deepEqual(
        events,
        ["start"],
        "Await continuation stays asynchronous"
    );
    assert.equal(await result, 42);
    assert.deepEqual(events, ["start", "resolved"]);
    const caught = [];
    assert.equal(
        await legacy.secondAsync(
            {
                then(_resolve, reject) {
                    reject(new Error("input rejected"));
                },
            },
            caught
        ),
        "caught"
    );
    assert.deepEqual(caught, ["input rejected", "finally"]);
    await assert.rejects(legacy.rejectAsync(), /failure after await/);
}

async function testWireProviderGlobals() {
    const wireModule = "build/shared/wire-contracts.js";
    write(
        wireModule,
        compile(
            fs.readFileSync(
                path.join(__dirname, "../src/shared/wire-contracts.ts"),
                "utf8"
            )
        )
    );
    write(
        "build/wire-consumer.js",
        compile(`
            import { validDeviceToken, validDeviceId, validPlayerCommand }
                from "./shared/wire-contracts";
            export function readWireValidation(value) {
                return [validDeviceToken(value), validDeviceId("device:1"),
                    validPlayerCommand({ command: "volume", volume: 10 })];
            }
        `)
    );
    const linked = assembleClassic(root, [
        wireModule,
        "build/wire-consumer.js",
    ]);
    const optimized = await optimizeClassic(linked);
    const provider = fs.readFileSync(
        path.join(__dirname, "../providers/only4/provider.js"),
        "utf8"
    );
    for (const source of [linked, optimized.code]) {
        acorn.parse(source, { ecmaVersion: 5 });
        let storedToken = "only4-token";
        const context = vm.createContext({
            stbGetItem(key) {
                return key === "o4token" ? storedToken : "";
            },
            version: "fixture",
        });
        const validToken = "a".repeat(32);
        vm.runInContext(source, context);
        assert.deepEqual(Array.from(context.readWireValidation(validToken)), [
            true,
            true,
            true,
        ]);
        vm.runInContext(provider, context);
        assert.equal(context.token, storedToken);
        assert.deepEqual(
            Array.from(context.readWireValidation(validToken)),
            [true, true, true],
            "Only4's classic global token must not overwrite wire validation state"
        );
        storedToken = "";
        context._getParams();
        assert.equal(context.token, "");
        assert.deepEqual(
            Array.from(context.readWireValidation("short")),
            [false, true, true],
            "Provider credential changes preserve the wire token contract"
        );
    }
}

async function testOrdinaryGlobalAliases() {
    write(
        "ordinary-dep.js",
        `
        export var ordinaryValue = "initial";
        export function ordinaryReceiver() { return this; }
        export function ordinaryStrictReceiver() { "use strict"; return this; }
    `
    );
    write(
        "ordinary-entry.js",
        `
        import { ordinaryValue as valueAlias, ordinaryReceiver as receiverAlias,
            ordinaryStrictReceiver as strictAlias } from "./ordinary-dep";
        export function directValue() { return valueAlias; }
        export function capturedValue(ordinaryValue) { return valueAlias; }
        export function ordinaryRecord() { return { valueAlias }; }
        export function ordinaryCalls() { return [receiverAlias(), strictAlias()]; }
        export function capturedReceiver(ordinaryReceiver) { return receiverAlias(); }
    `
    );
    const linked = assembleClassic(root, [
        "ordinary-dep.js",
        "ordinary-entry.js",
    ]);
    assert.match(
        linked,
        /function directValue\(\) \{ return ordinaryValue; \}/
    );
    const optimized = await optimizeClassic(linked);
    for (const source of [linked, optimized.code]) {
        acorn.parse(source, { ecmaVersion: 5 });
        const context = vm.createContext({});
        vm.runInContext(source, context);
        assert.equal(context.directValue(), "initial");
        context.ordinaryValue = "replaced by provider";
        assert.equal(context.directValue(), "replaced by provider");
        assert.equal(context.capturedValue("local"), "replaced by provider");
        assert.equal(
            context.ordinaryRecord().valueAlias,
            "replaced by provider"
        );
        const realm = vm.runInContext("this", context);
        assert.equal(context.ordinaryCalls()[0], realm);
        assert.equal(context.ordinaryCalls()[1], undefined);
        assert.equal(
            context.capturedReceiver(() => "local"),
            realm
        );
        vm.runInContext(
            'ordinaryReceiver = function () { return "new callback"; };',
            context
        );
        assert.equal(context.ordinaryCalls()[0], "new callback");
        assert.equal(
            context.capturedReceiver(() => "local"),
            "new callback"
        );
    }
    for (const [label, body] of [
        [
            "bare eval",
            `eval("var ordinaryValue = 'local eval binding';"); return valueAlias;`,
        ],
        [
            "parenthesized eval",
            `(eval)("var ordinaryValue = 'local eval binding';"); return valueAlias;`,
        ],
        [
            "nested parentheses",
            `(((eval)))("var ordinaryValue = 'local eval binding';"); return valueAlias;`,
        ],
        [
            "eval in nested function",
            `return (function () { ((eval))("var ordinaryValue = 'local eval binding';"); return valueAlias; })();`,
        ],
    ]) {
        write(
            "ordinary-dynamic.js",
            `
        import { ordinaryValue as valueAlias } from "./ordinary-dep";
        export function readDynamic() {
            ${body}
        }
    `
        );
        const dynamic = assembleClassic(root, [
            "ordinary-dep.js",
            "ordinary-dynamic.js",
        ]);
        const optimizedDynamic = await optimizeClassic(dynamic);
        for (const source of [dynamic, optimizedDynamic.code]) {
            acorn.parse(source, { ecmaVersion: 5 });
            const context = vm.createContext({});
            vm.runInContext(source, context);
            assert.equal(
                context.readDynamic(),
                "initial",
                label + " cannot capture a lowered import"
            );
            context.ordinaryValue = "changed";
            assert.equal(context.readDynamic(), "changed", label);
        }
    }
}

async function testSharedBootstrapBridge() {
    const runtimeFile = "build/polyfills/runtime.js";
    const appFile = "build/polyfills/index.js";
    assert(
        !CLASSIC_MODULES.includes(runtimeFile),
        "The media bootstrap owns web shims"
    );
    for (const name of ["runtime", "index"]) {
        write(
            "build/polyfills/" + name + ".js",
            compile(
                fs.readFileSync(
                    path.join(__dirname, "../src/polyfills/" + name + ".ts"),
                    "utf8"
                )
            )
        );
    }
    const linked = assembleClassic(root, [appFile]);
    const parts = assembleClassic(root, [appFile], { parts: true });
    assert.match(parts.prelude, /Missing shared runtime bootstrap/);
    assert.equal(parts.parts[0].file, appFile);
    assert(!parts.parts[0].code.includes("Missing shared runtime bootstrap"));
    assert.equal(parts.prelude + parts.parts[0].code, linked);
    const optimized = await optimizeClassic(linked);
    const bootstrap = fs.readFileSync(
        path.join(__dirname, "../js/runtime-polyfills.js"),
        "utf8"
    );
    for (const source of [linked, optimized.code]) {
        acorn.parse(source, { ecmaVersion: 5 });
        assert(!source.includes("function installTextEncoder"));
        assert(!source.includes("function applyWebRuntimePolyfills"));
        for (const state of [
            "function applyWebRuntimePolyfills() {}",
            "window.__ottRuntimePolyfillsReady = true;",
        ]) {
            const missing = vm.createContext({});
            vm.runInContext("var window = this; " + state, missing);
            assert.throws(
                () => vm.runInContext(source, missing),
                /Missing shared runtime bootstrap/
            );
        }
        const context = vm.createContext({});
        vm.runInContext(
            "var window = this; var self = this; TextEncoder = undefined; performance = undefined;",
            context
        );
        vm.runInContext(bootstrap, context);
        const installed = {
            apply: context.applyWebRuntimePolyfills,
            encoder: context.TextEncoder,
            now: context.performance.now,
        };
        vm.runInContext(source, context);
        assert.equal(context.TextEncoder, installed.encoder);
        assert.equal(context.performance.now, installed.now);
        assert.equal(context.applyWebRuntimePolyfills, installed.apply);
        assert.equal(
            vm.runInContext(
                "Date.setTimezoneOffset(-180); applyPolyfills(); Date.getTimezoneOffset()",
                context
            ),
            -180
        );
        assert.equal(vm.runInContext("new Date(0).getHours()", context), 3);
        assert.equal(vm.runInContext("new Date(0).getTime()", context), 0);
    }
    assert.throws(
        () => assembleClassic(root, [runtimeFile, appFile]),
        /external bootstrap bridge/
    );
    write(
        "build/bootstrap-invalid.js",
        'import { installTextEncoder } from "./polyfills/runtime"; installTextEncoder();'
    );
    assert.throws(
        () => assembleClassic(root, ["build/bootstrap-invalid.js"]),
        /external bootstrap bridge/
    );
    write("build/bootstrap-invalid.js", 'import "./polyfills/runtime";');
    assert.throws(
        () => assembleClassic(root, ["build/bootstrap-invalid.js"]),
        /cannot be imported for side effects/
    );
    write(runtimeFile, "export var applyWebRuntimePolyfills = 1;");
    assert.throws(
        () => assembleClassic(root, [appFile]),
        /external bootstrap bridge/
    );
}

async function main() {
    try {
        testInventoryWithoutCompiler();
        write(
            "dep.js",
            "export var video = null; export function setVideo(v) { video = v; }"
        );
        write(
            "entry.js",
            `
        import {
            video as videoElement,
            setVideo
        } from "./dep";
        export function read(video) { return videoElement; }
        export function shadow(videoElement) { return videoElement; }
        export function record() { return { videoElement }; }
        export function property(object) { return object.videoElement; }
        export function valueType() { return typeof videoElement; }
    `
        );
        const linked = assembleClassic(root, ["dep.js", "entry.js"]);
        const parts = assembleClassic(root, ["dep.js", "entry.js"], {
            parts: true,
        });
        assert.deepEqual(
            parts.parts.map((part) => part.file),
            ["dep.js", "entry.js"],
            "Attribution retains the supplied module order"
        );
        assert.match(parts.prelude, /function __ottReadImport/);
        assert.match(parts.parts[0].code, /function setVideo/);
        assert.match(parts.parts[1].code, /function read/);
        assert.equal(
            parts.prelude + parts.parts.map((part) => part.code).join("\n"),
            linked,
            "Attribution includes the exact checked reader prelude and linked module text"
        );
        acorn.parse(linked, { ecmaVersion: 5 });
        const context = vm.createContext({});
        vm.runInContext(linked, context);
        assert.equal(context.read("wrong captured parameter"), null);
        const player = { position: 12 };
        context.setVideo(player);
        assert.equal(
            context.read("wrong captured parameter"),
            player,
            "Imported mutable binding stays live"
        );
        assert.equal(
            context.shadow("local"),
            "local",
            "Do not rewrite locally shadowed bindings"
        );
        assert.equal(
            context.record().videoElement,
            player,
            "Preserve shorthand property keys"
        );
        assert.equal(
            context.property({ videoElement: 5 }),
            5,
            "Do not rewrite member names"
        );
        assert.equal(context.valueType(), "object");
        assert.throws(
            () => assembleClassic(root, ["entry.js"]),
            /not in CLASSIC_MODULES/
        );
        write(
            "external.js",
            'import { video } from "unknown-package"; export function read() { return video; }'
        );
        assert.throws(
            () => assembleClassic(root, ["external.js"]),
            /not in CLASSIC_MODULES/
        );
        write(
            "namespace.js",
            'import * as data from "./dep"; export function read() { return data.video; }'
        );
        assert.throws(
            () => assembleClassic(root, ["dep.js", "namespace.js"]),
            /named imports/
        );
        write(
            "build/app/state.js",
            "export var popupActions = []; export var arbitrary = 1;"
        );
        write(
            "build/index.js",
            'var popupActions = ["provided by classic entry"];'
        );
        write(
            "build/provider.js",
            'import { popupActions as actions } from "./app/state"; export function getActions() { return actions; }'
        );
        const bridgeContext = vm.createContext({});
        vm.runInContext(
            assembleClassic(root, ["build/provider.js", "build/index.js"]),
            bridgeContext
        );
        assert.equal(
            bridgeContext.getActions()[0],
            "provided by classic entry"
        );
        assert.throws(
            () => assembleClassic(root, ["build/provider.js"]),
            /missing explicit classic bridge/
        );
        write(
            "build/provider.js",
            'import { arbitrary } from "./app/state"; export function get() { return arbitrary; }'
        );
        assert.throws(
            () =>
                assembleClassic(root, ["build/provider.js", "build/index.js"]),
            /missing explicit classic bridge/
        );
        await testHelpers();
        await testPrivateBoundary();
        await testNativeHttpBoundary();
        await testWindowsPaths();
        await testWireProviderGlobals();
        await testOrdinaryGlobalAliases();
        await testSharedBootstrapBridge();
        console.log(
            "PASS: classic ES5 linker preserves live aliases, lexical bindings and async behavior; validates ABI bridges and deduplicates identical TypeScript helpers"
        );
    } finally {
        fs.rmSync(root, { force: true, recursive: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
