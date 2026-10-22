const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("acorn");
const { minify } = require("terser");
const ts = require("typescript");
const {
    classicOptimizerMetadata,
    classicOptimizerOptions,
    optimizeClassic,
} = require("../scripts/classic-optimizer.cjs");
const {
    CLASSIC_PLAYER_NAME_POLICY,
} = require("../scripts/classic-function-names.cjs");

let count = 0;
async function test(name, source, exercise, policy) {
    const optimized = await optimizeClassic(source, policy);
    parse(optimized.code, { ecmaVersion: 5, sourceType: "script" });
    for (const code of [source, optimized.code]) {
        const context = vm.createContext({});
        context.window = context;
        vm.runInContext(code, context);
        await exercise(context);
    }
    count++;
    console.log("PASS classic optimizer: " + name);
    return optimized;
}

async function rejectUnsafeControl(name, source, overrides, exercise) {
    const options = classicOptimizerMetadata().options;
    Object.assign(options.compress, overrides);
    const optimized = await minify(source, options);
    parse(optimized.code, { ecmaVersion: 5, sourceType: "script" });
    const context = vm.createContext({});
    context.window = context;
    vm.runInContext(optimized.code, context);
    await assert.rejects(
        async () => exercise(context),
        (error) => error instanceof assert.AssertionError,
        name + ": the unsafe control must violate the same runtime contract"
    );
    console.log("PASS classic optimizer rejected control: " + name);
}

async function exerciseNativeBooleanContract(context) {
    const calls = [];
    const persisted = [];
    let nativeStatus = true;
    const remote = context.createLocalHttpRemote(
        {
            clearInterval() {},
            crypto: {
                getRandomValues(bytes) {
                    bytes.fill(23);
                    return bytes;
                },
            },
            setInterval() {
                return 1;
            },
            sLocalCmdUrl: "",
        },
        (enabled, code) => {
            assert.equal(
                typeof enabled,
                "boolean",
                "Native configure receives a boolean"
            );
            const wire = JSON.parse(
                JSON.stringify({ code, httpEnabled: enabled })
            );
            assert.equal(
                typeof wire.httpEnabled,
                "boolean",
                "IPC JSON retains boolean types"
            );
            calls.push(wire);
            return Promise.resolve({
                httpEnabled: enabled ? nativeStatus : false,
                port: enabled ? 18081 : 0,
            });
        },
        (enabled, code) => {
            assert.equal(
                typeof enabled,
                "boolean",
                "Persistence receives a boolean"
            );
            persisted.push({ code, enabled });
        }
    );
    assert.equal(remote.status().enabled, false);
    assert.equal(remote.status().ready, false);
    await remote.setEnabled(true);
    assert.equal(remote.status().enabled, true);
    assert.equal(remote.status().ready, true);
    assert.equal(remote.status().port, 18081);
    assert.deepEqual(
        calls.map((value) => value.httpEnabled),
        [false, true]
    );
    assert.equal(JSON.parse(JSON.stringify(remote.status())).enabled, true);
    assert.equal(persisted.at(-1).enabled, true);
    assert.match(persisted.at(-1).code, /^[0-9a-f]{64}$/);
    await remote.setEnabled(1);
    assert.equal(
        remote.status().enabled,
        false,
        "A numeric truthy value is not explicit consent"
    );
    assert.equal(calls.at(-1).httpEnabled, false);
    for (const value of [1, "true", false, null]) {
        nativeStatus = value;
        await assert.rejects(remote.setEnabled(true), /could not be started/);
        assert.equal(
            remote.status().enabled,
            false,
            "Only native boolean true confirms startup"
        );
        assert.equal(
            remote.status().ready,
            true,
            "Rejected native startup is revoked"
        );
        assert.equal(calls.at(-1).httpEnabled, false);
    }
}

async function main() {
    await test(
        "later scripts mutate state, replace callbacks and add providers",
        `var playerMode = 0;
        var settings = { volume: 10 };
        var providerState;
        function getMode() { return playerMode; }
        function getVolume() { return settings.volume; }
        function playChannel(id) { return "initial:" + id; }
        function invokePlayback(id) { return playChannel(id); }
        function getProvider() { return providerState; }
        function lateProvider(id) { return providerLoadedLater(id); }
        function unusedPublicCallback(id) { return "late:" + id; }`,
        (context) => {
            assert.equal(context.getMode(), 0);
            vm.runInContext(
                `playerMode = 2; settings.volume = 35;
                playChannel = function(id) { return "provider:" + id; };
                providerState = { ready: true };
                function providerLoadedLater(id) { return "loaded:" + id; }`,
                context
            );
            assert.equal(context.getMode(), 2);
            assert.equal(context.getVolume(), 35);
            assert.equal(context.invokePlayback("news"), "provider:news");
            assert.equal(context.getProvider().ready, true);
            assert.equal(context.lateProvider("sport"), "loaded:sport");
            assert.equal(context.unusedPublicCallback("film"), "late:film");
            context.settings = { volume: 70 };
            assert.equal(context.getVolume(), 70);
        }
    );
    await test(
        "escaped closures and reentrant host callbacks observe live bindings",
        `var channelIndex = 1;
        var getListItemFn = function(id) { return "initial:" + id; };
        function createLegacyCallback(register) {
            var callbackCount = 0;
            register(function legacyCallback() {
                callbackCount++;
                return [callbackCount, channelIndex, getListItemFn(channelIndex)];
            });
        }
        function inspectAfterHostCall(hostCall) {
            var previousChannel = channelIndex;
            hostCall();
            return [previousChannel, channelIndex, getListItemFn(channelIndex)];
        }`,
        (context) => {
            let callback;
            context.createLegacyCallback((value) => {
                callback = value;
            });
            assert.equal(callback.name, "legacyCallback");
            assert.deepEqual(Array.from(callback()), [1, 1, "initial:1"]);
            const after = context.inspectAfterHostCall(() => {
                context.channelIndex = 4;
                context.getListItemFn = (id) => "provider:" + id;
            });
            assert.deepEqual(Array.from(after), [1, 4, "provider:4"]);
            assert.deepEqual(Array.from(callback()), [2, 4, "provider:4"]);
        }
    );
    await test(
        "callback names, arity, receiver, arguments and menu identities survive",
        `function createMenu() {
            function showSettings(unusedEvent, unusedState) { return this.label; }
            var selectChannel = function(unusedEvent, unusedState, unusedMode) {
                return arguments.length;
            };
            return { showSettings: showSettings, selectChannel: selectChannel };
        }
        var menu = createMenu();
        function publicCallback(event, unusedState, unusedMode) { return event; }`,
        (context) => {
            const { menu } = context;
            assert.equal(menu.showSettings.name, "showSettings");
            assert.equal(menu.selectChannel.name, "selectChannel");
            assert.equal(menu.showSettings.length, 2);
            assert.equal(menu.selectChannel.length, 3);
            assert.equal(context.publicCallback.name, "publicCallback");
            assert.equal(context.publicCallback.length, 3);
            assert.equal(
                menu.showSettings.call({ label: "Settings" }),
                "Settings"
            );
            assert.equal(menu.selectChannel(1), 1);
            assert.equal(menu.selectChannel(1, 2, 3, 4), 4);
            const hidden = ["showSettings"];
            assert.equal(hidden.indexOf(menu.showSettings.name), 0);
        }
    );
    await test(
        "direct eval keeps lexical names; dynamic code keeps classic globals",
        `var globalChannel = "first";
        function directLookup(value) {
            var localChannelName = value;
            return eval("localChannelName");
        }
        function indirectLookup() { return (0, eval)("globalChannel"); }
        function dynamicLookup() { return new Function("return globalChannel")(); }
        function withLookup(nativeState) {
            var currentChannelName = "fallback";
            with (nativeState) { return currentChannelName; }
        }
        function legacyLookup() { return window["directLookup"]("legacy"); }`,
        (context) => {
            assert.equal(context.directLookup("local"), "local");
            assert.equal(context.legacyLookup(), "legacy");
            context.globalChannel = "changed";
            assert.equal(context.indirectLookup(), "changed");
            assert.equal(context.dynamicLookup(), "changed");
            assert.equal(context.withLookup({}), "fallback");
            assert.equal(
                context.withLookup({ currentChannelName: "native" }),
                "native"
            );
        }
    );
    await test(
        "host getters and externally replaceable methods retain side effects",
        `var reads = 0;
        var nativePlayer = {};
        Object.defineProperty(nativePlayer, "status", {
            get: function() { reads++; return "playing"; }
        });
        function observePlayer() { nativePlayer.status; return reads; }
        function readMissing() { return unknownNativeBridge.status; }
        function optionalBridge() { return typeof optionalNativeBridge; }
        function channelText(value) { return value.toString(); }`,
        (context) => {
            assert.equal(context.observePlayer(), 1);
            assert.equal(context.observePlayer(), 2);
            assert.throws(() => context.readMissing(), /unknownNativeBridge/);
            assert.equal(context.optionalBridge(), "undefined");
            context.optionalNativeBridge = {};
            assert.equal(context.optionalBridge(), "object");
            assert.equal(
                context.channelText({ toString: () => "provider" }),
                "provider"
            );
        }
    );
    await test(
        "hoisted globals, startup ordering and sloppy-script receiver are preserved",
        `var firstUse = getInitialChannel();
        var laterValue = "ready";
        if (false) { var externalFutureState = 1; }
        for (var startupIndex = 0; startupIndex < 2; startupIndex++) {}
        function getInitialChannel() { return laterValue; }
        function getReceiver() { return this; }
        function readFutureState() { return externalFutureState; }`,
        (context) => {
            assert.equal(context.firstUse, undefined);
            assert.equal(context.getInitialChannel(), "ready");
            assert.equal(context.startupIndex, 2);
            assert.equal(context.getReceiver().window, context.window);
            assert.equal(context.readFutureState(), undefined);
            context.externalFutureState = "provided";
            assert.equal(context.readFutureState(), "provided");
        }
    );
    // These are language/runtime boundaries used by UI accessors, native bridge
    // probes and jQuery wrappers. A modern VM exercises their ES5 semantics;
    // it does not establish correctness on an actual IE or television engine.
    await test(
        "host accessors can replace public callbacks during the same expression",
        `var callback = function initialCallback(value) { return "initial:" + value; };
        var writes = 0;
        Object.defineProperty(window, "listKeyHandler", {
            configurable: true,
            get: function() { return callback; },
            set: function(value) { writes++; callback = value; }
        });
        function dispatchAfterStatus(bridge, value) {
            var previous = window.listKeyHandler;
            bridge.status;
            return [previous(value), window.listKeyHandler(value), writes];
        }`,
        (context) => {
            let reads = 0;
            const bridge = {};
            Object.defineProperty(bridge, "status", {
                get() {
                    reads++;
                    context.listKeyHandler = (value) => "provider:" + value;
                    return "ready";
                },
            });
            assert.deepEqual(
                Array.from(context.dispatchAfterStatus(bridge, "news")),
                ["initial:news", "provider:news", 1]
            );
            assert.equal(reads, 1);
            assert.deepEqual(
                Array.from(context.dispatchAfterStatus(bridge, "film")),
                ["provider:film", "provider:film", 2]
            );
            assert.equal(reads, 2);
            const failure = new Error("native status unavailable");
            assert.throws(
                () =>
                    context.dispatchAfterStatus(
                        {
                            get status() {
                                throw failure;
                            },
                        },
                        "news"
                    ),
                (error) => error === failure
            );
        }
    );
    await test(
        "native method probes retain repeated getter reads, receiver and replacement",
        `function nativePlay(bridge, options) {
            if (typeof bridge.play === "function") return bridge.play(options);
            return "unavailable";
        }
        function wrappedCall(original) {
            return function showWithState(first, second) {
                first = "updated:" + first;
                return original.apply(this, arguments);
            };
        }`,
        (context) => {
            let reads = 0;
            const options = { channel: "news" };
            const bridge = {};
            Object.defineProperty(bridge, "play", {
                configurable: true,
                get() {
                    const read = ++reads;
                    return function (value) {
                        assert.equal(this, bridge);
                        assert.equal(value, options);
                        return "read:" + read;
                    };
                },
            });
            assert.equal(context.nativePlay(bridge, options), "read:2");
            assert.equal(reads, 2);
            Object.defineProperty(bridge, "play", {
                value(value) {
                    assert.equal(this, bridge);
                    return "replacement:" + value.channel;
                },
            });
            assert.equal(
                context.nativePlay(bridge, options),
                "replacement:news"
            );
            assert.equal(
                context.nativePlay({ play: false }, options),
                "unavailable"
            );
            const receiver = { name: "menu" };
            const wrapped = context.wrappedCall(function () {
                assert.equal(this, receiver);
                return Array.from(arguments);
            });
            assert.equal(wrapped.name, "showWithState");
            assert.equal(wrapped.length, 2);
            assert.deepEqual(wrapped.call(receiver, "one", "two", "three"), [
                "updated:one",
                "two",
                "three",
            ]);
        }
    );
    await test(
        "metadata and setting conversion retain primitive hints and thrown errors",
        `function metadataText(value) { return String(value); }
        function settingNumber(value) { return Number(value); }
        function joinedLabel(value) { return "channel:" + value; }
        function compareDuration(value) { return value < 10; }`,
        (context) => {
            const calls = [];
            const value = {
                toString() {
                    calls.push("string");
                    return "News";
                },
                valueOf() {
                    calls.push("number");
                    return 7;
                },
            };
            assert.equal(context.metadataText(value), "News");
            assert.deepEqual(calls.splice(0), ["string"]);
            assert.equal(context.settingNumber(value), 7);
            assert.deepEqual(calls.splice(0), ["number"]);
            assert.equal(context.joinedLabel(value), "channel:7");
            assert.deepEqual(calls.splice(0), ["number"]);
            assert.equal(context.compareDuration(value), true);
            assert.deepEqual(calls.splice(0), ["number"]);
            const fallback = {
                toString() {
                    calls.push("string");
                    return "12";
                },
                valueOf() {
                    calls.push("number");
                    return {};
                },
            };
            assert.equal(context.settingNumber(fallback), 12);
            assert.deepEqual(calls.splice(0), ["number", "string"]);
            const failure = new Error("provider conversion failed");
            assert.throws(
                () =>
                    context.metadataText({
                        toString() {
                            throw failure;
                        },
                        valueOf() {
                            return 1;
                        },
                    }),
                (error) => error === failure
            );
            assert.throws(
                () =>
                    context.settingNumber({
                        toString() {
                            return "1";
                        },
                        valueOf() {
                            throw failure;
                        },
                    }),
                (error) => error === failure
            );
            assert.equal(
                context.metadataText(Symbol("channel")),
                "Symbol(channel)"
            );
        }
    );
    await test(
        "sloppy arguments mappings survive writes, deletion and descriptor changes",
        `function mappedArguments(first, second) {
            arguments[0] = "argument-write";
            second = "parameter-write";
            return [first, arguments[0], second, arguments[1], arguments.length];
        }
        function deletedArgument(value) {
            delete arguments[0];
            value = "parameter-only";
            return [value, arguments[0], 0 in arguments];
        }
        function descriptorArgument(value) {
            Object.defineProperty(arguments, "0", { value: "descriptor-write" });
            var linked = value;
            Object.defineProperty(arguments, "0", { writable: false });
            value = "parameter-only";
            return [linked, value, arguments[0]];
        }
        function accessorArgument(value) {
            Object.defineProperty(arguments, "0", { get: function() { return "accessor"; } });
            value = "parameter-only";
            return [value, arguments[0]];
        }`,
        (context) => {
            assert.deepEqual(
                Array.from(context.mappedArguments("one", "two")),
                [
                    "argument-write",
                    "argument-write",
                    "parameter-write",
                    "parameter-write",
                    2,
                ]
            );
            assert.deepEqual(Array.from(context.mappedArguments()), [
                undefined,
                "argument-write",
                "parameter-write",
                undefined,
                0,
            ]);
            assert.deepEqual(Array.from(context.deletedArgument("one")), [
                "parameter-only",
                undefined,
                false,
            ]);
            assert.deepEqual(Array.from(context.descriptorArgument("one")), [
                "descriptor-write",
                "parameter-only",
                "descriptor-write",
            ]);
            assert.deepEqual(Array.from(context.accessorArgument("one")), [
                "parameter-only",
                "accessor",
            ]);
        }
    );
    await test(
        "duplicate formal parameters map only the final supplied argument",
        `function duplicateParameters(value, value) {
            var initial = value;
            arguments[0] = "first-write";
            var afterFirst = value;
            arguments[1] = "second-write";
            var afterSecond = value;
            value = "parameter-write";
            return [initial, afterFirst, afterSecond, arguments[0], arguments[1]];
        }`,
        (context) => {
            assert.equal(context.duplicateParameters.length, 2);
            assert.deepEqual(
                Array.from(context.duplicateParameters("one", "two")),
                ["two", "two", "second-write", "first-write", "parameter-write"]
            );
            assert.deepEqual(Array.from(context.duplicateParameters("one")), [
                undefined,
                undefined,
                undefined,
                "first-write",
                "second-write",
            ]);
        }
    );
    const omittedArgument = `function readOmittedArgument(value) {
        value = 7;
        return [arguments[0], arguments.length];
    }`;
    const exerciseOmittedArgument = (context) => {
        assert.deepEqual(Array.from(context.readOmittedArgument()), [
            undefined,
            0,
        ]);
        assert.deepEqual(Array.from(context.readOmittedArgument(1)), [7, 1]);
    };
    await test(
        "omitted actual arguments do not acquire parameter writes",
        omittedArgument,
        exerciseOmittedArgument
    );
    await rejectUnsafeControl(
        "arguments rewriting loses omitted-argument semantics",
        omittedArgument,
        { arguments: true },
        exerciseOmittedArgument
    );
    await test(
        "first-use constructors, prototype updates and later native factories stay observable",
        `var initialRecord = new ChannelRecord("boot");
        function ChannelRecord(label) { this.label = label; }
        ChannelRecord.prototype.state = "ready";
        function makeNativePlayer(options) { return new window.NativePlayer(options); }
        function makeLegacyList(size) { return new Array(size); }
        function makeLocalRecord() {
            function SavedChannel(value, unused) { this.value = value; }
            return SavedChannel;
        }`,
        (context) => {
            assert.equal(context.initialRecord.label, "boot");
            assert.equal(context.initialRecord.state, "ready");
            assert.equal(
                context.initialRecord instanceof context.ChannelRecord,
                true
            );
            context.ChannelRecord.prototype.state = "changed";
            assert.equal(context.initialRecord.state, "changed");
            const first = function NativePlayer(options) {
                this.channel = options.channel;
            };
            context.NativePlayer = first;
            const instance = context.makeNativePlayer({ channel: "news" });
            assert.equal(instance instanceof first, true);
            assert.equal(instance.channel, "news");
            context.NativePlayer = function () {
                return { replacement: true };
            };
            assert.equal(context.makeNativePlayer({}).replacement, true);
            const list = context.makeLegacyList(3);
            assert.equal(list.length, 3);
            assert.equal(0 in list, false);
            context.Array = function LegacyArray(size) {
                return { legacySize: size };
            };
            assert.equal(context.makeLegacyList(4).legacySize, 4);
            const LocalRecord = context.makeLocalRecord();
            assert.equal(LocalRecord.name, "SavedChannel");
            assert.equal(LocalRecord.length, 2);
            assert.equal(new LocalRecord("film").value, "film");
        }
    );
    await test(
        "media arithmetic keeps signed zero, non-finite duration and rounding boundaries",
        `function mediaRatio(position, duration) { return position / duration; }
        function roundedOffset(position) { return position + 1 - 1; }
        function zeroDuration(duration) { return duration * 0; }
        function shiftedDelta(position) { return position - (position - 0.1); }`,
        (context) => {
            assert.equal(Object.is(context.mediaRatio(-0, 1), -0), true);
            assert.equal(
                Number.isNaN(context.mediaRatio(Infinity, Infinity)),
                true
            );
            assert.equal(Number.isNaN(context.zeroDuration(Infinity)), true);
            assert.equal(Object.is(context.zeroDuration(-1), -0), true);
            assert.equal(
                context.roundedOffset(9007199254740992),
                9007199254740991
            );
            assert.equal(context.shiftedDelta(1000000000000), 0.0999755859375);
        }
    );
    // A negative control proves that the accessor contract can reject an
    // aggressive profile, rather than merely accepting equivalent formatting.
    const getterControl = `function observeNativeStatus(bridge) { bridge.status; return "observed"; }`;
    const exerciseGetter = (context) => {
        let reads = 0;
        context.observeNativeStatus({
            get status() {
                reads++;
                return "ready";
            },
        });
        assert.equal(reads, 1);
    };
    await test(
        "native accessor negative control retains observable getter effects",
        getterControl,
        exerciseGetter
    );
    await rejectUnsafeControl(
        "pure getters lose native accessor effects",
        getterControl,
        { pure_getters: true },
        exerciseGetter
    );

    // Exercise the real native consent controller, including its ES5 async
    // emission. Native IPC and persisted state require booleans, not 0/1.
    const nativeRemote = ts
        .transpileModule(
            fs.readFileSync(
                path.join(__dirname, "../src/plugins/local-http-remote.ts"),
                "utf8"
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
    await test(
        "real native HTTP consent retains strict booleans and serialized payload types",
        nativeRemote,
        exerciseNativeBooleanContract
    );
    await rejectUnsafeControl(
        "integer booleans break the native consent contract",
        nativeRemote,
        { booleans_as_integers: true },
        exerciseNativeBooleanContract
    );
    const privateHelpers = await test(
        "direct-call private helpers shrink while published callbacks retain identity",
        `function createControls() {
            function calculatePrivateChannelOffset(position) { return position * 2 + 1; }
            function publishedSelection(position, unusedEvent) {
                return calculatePrivateChannelOffset(position);
            }
            return publishedSelection;
        }
        function recursiveResult(value) {
            function privateRecursiveSum(number) {
                return number ? number + privateRecursiveSum(number - 1) : 0;
            }
            return privateRecursiveSum(value);
        }`,
        (context) => {
            const action = context.createControls();
            assert.equal(action.name, "publishedSelection");
            assert.equal(action.length, 2);
            assert.equal(action(4), 9);
            assert.equal(context.recursiveResult(4), 10);
        }
    );
    assert(!privateHelpers.code.includes("calculatePrivateChannelOffset"));
    assert(!privateHelpers.code.includes("privateRecursiveSum"));
    assert(privateHelpers.code.includes("publishedSelection"));
    const popupNamesSource = ts
        .transpileModule(
            fs.readFileSync(
                path.join(__dirname, "../src/compatibility/legacy-names.ts"),
                "utf8"
            ),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^export /gm, "");
    const productionNames = await test(
        "player profile preserves persisted provider menu IDs, arity and live globals",
        popupNamesSource +
            `
        var playerSelection = 1;
        function createPlayerCallbacks() {
            function settingsMenu(hostCall, unusedState) {
                var previous = playerSelection;
                hostCall();
                return [previous, playerSelection, this.label, arguments.length];
            }
            function privatePlaybackCompletion(value, unusedState) { return value + playerSelection; }
            return { action: settingsMenu, complete: privatePlaybackCompletion };
        }
        var providerCallbacks = createPlayerCallbacks();`,
        (context) => {
            const action = context.providerCallbacks.action;
            assert.equal(action.name, "settingsMenu");
            assert.equal(action.length, 2);
            assert.equal(
                context.createPlayerCallbacks.name,
                "createPlayerCallbacks"
            );
            assert.equal(context.popupActionId(action), "settingsMenu");
            const savedHiddenMenus = ["settingsMenu"];
            assert(savedHiddenMenus.includes(context.popupActionId(action)));
            assert.deepEqual(
                Array.from(
                    action.call({ label: "Provider" }, () => {
                        context.playerSelection = 9;
                    })
                ),
                [1, 9, "Provider", 1]
            );
            assert.equal(context.providerCallbacks.complete.length, 2);
            assert.equal(context.providerCallbacks.complete(2), 11);
            vm.runInContext(
                "function providerLoadedLater() { return 'external'; }",
                context
            );
            assert.equal(
                context.popupActionId(context.providerLoadedLater),
                "providerLoadedLater"
            );
        },
        CLASSIC_PLAYER_NAME_POLICY
    );
    assert(!productionNames.code.includes("privatePlaybackCompletion"));
    assert.equal(
        productionNames.report.optimizer.contracts.functionNames,
        "globals-and-retained"
    );
    assert(
        productionNames.report.optimizer.retainedFunctionNames.includes(
            "settingsMenu"
        )
    );
    const retainedActionsSource =
        "function providerMenuActions() { " +
        CLASSIC_PLAYER_NAME_POLICY.retainedFunctionNames
            .map(
                (name) =>
                    "function " + name + "(value, unused) { return value; }"
            )
            .join("\n") +
        " return [" +
        CLASSIC_PLAYER_NAME_POLICY.retainedFunctionNames.join(",") +
        "]; }";
    await test(
        "every built-in provider action keeps its persisted spelling",
        retainedActionsSource,
        (context) => {
            const actions = Array.from(context.providerMenuActions());
            assert.deepEqual(
                actions.map((action) => action.name),
                Array.from(CLASSIC_PLAYER_NAME_POLICY.retainedFunctionNames)
            );
            actions.forEach((action) => {
                assert.equal(action.length, 2);
                assert.equal(action("saved"), "saved");
            });
        },
        CLASSIC_PLAYER_NAME_POLICY
    );
    const optionsProbe =
        "function playerCallbacks(){ function completion(value){ return value; } return completion; }";
    const optionsResult = await minify(
        optionsProbe,
        classicOptimizerOptions(optionsProbe, CLASSIC_PLAYER_NAME_POLICY)
    );
    assert.equal(
        optionsResult.code,
        (await optimizeClassic(optionsProbe, CLASSIC_PLAYER_NAME_POLICY)).code
    );
    for (const policy of [
        null,
        {},
        { retainedFunctionNames: ["invalid.name"] },
    ])
        await assert.rejects(
            optimizeClassic("var player = 1;", policy),
            /Invalid retained classic function names/
        );
    const dynamicPlayerSources = [
        'function dynamicPlayer() { return eval("settingsMenu"); }',
        'function dynamicPlayer() { return (0, eval)("settingsMenu"); }',
        'function dynamicPlayer() { return new Function("return settingsMenu")(); }',
        'function dynamicPlayer() { return Function("return settingsMenu")(); }',
        'function dynamicPlayer() { return window["Fun" + "ction"]("return settingsMenu")(); }',
        'function dynamicPlayer() { return window["ev" + "al"]("settingsMenu"); }',
        "function dynamicPlayer(host) { with (host) { return settingsMenu; } }",
        "function dynamicPlayer() { return arguments.callee.caller.name; }",
        'function dynamicPlayer() { return arguments["callee"]["caller"].name; }',
        'function dynamicPlayer() { var first = "cal" + "lee", second = "call" + "er"; return arguments[first][second].name; }',
        'function dynamicPlayer(callback) { return callback["cal" + "ler"].name; }',
        "function dynamicPlayer(key) { return arguments[key].name; }",
    ];
    for (const source of dynamicPlayerSources) {
        await assert.rejects(
            optimizeClassic(source, CLASSIC_PLAYER_NAME_POLICY),
            /name policy requires static scope/,
            source
        );
        assert.throws(
            () => classicOptimizerOptions(source, CLASSIC_PLAYER_NAME_POLICY),
            /name policy requires static scope/,
            "The measurement API enforces the same production boundary"
        );
    }
    await test(
        "player profile allows numeric arguments loops and ordinary metadata names",
        `function capturePlayerArguments() {
            var values = [];
            for (var i = 0; i < arguments.length; i++) values.push(arguments[i]);
            return values;
        }
        function metadataName(record) { return record.name; }`,
        (context) => {
            assert.deepEqual(
                Array.from(context.capturePlayerArguments("news", 3)),
                ["news", 3]
            );
            assert.equal(context.metadataName({ name: "Channel" }), "Channel");
        },
        CLASSIC_PLAYER_NAME_POLICY
    );
    await test(
        "a private helper's spelling cannot rename a same-named escaped function",
        `function internalResult(value) {
            function sharedSpelling(number) { return number + 1; }
            return sharedSpelling(value);
        }
        function externalAction() {
            var sharedSpelling = function sharedSpelling(value, unused) { return value; };
            return sharedSpelling;
        }
        function constructorResult() {
            function PrivateRecord(value) { this.value = value; }
            return new PrivateRecord("ready");
        }`,
        (context) => {
            assert.equal(context.internalResult(4), 5);
            const action = context.externalAction();
            assert.equal(action.name, "sharedSpelling");
            assert.equal(action.length, 2);
            const record = context.constructorResult();
            assert.equal(record.constructor.name, "PrivateRecord");
            assert.equal(record.value, "ready");
        }
    );
    await test(
        "reflection retains the name of a directly called private helper",
        `function reflectedResult() {
            function reflectedPrivateHelper() { return observeCallerName(); }
            return reflectedPrivateHelper();
        }
        function observeCallerName() { return arguments.callee.caller.name; }`,
        (context) => {
            assert.equal(context.reflectedResult(), "reflectedPrivateHelper");
        }
    );
    await test(
        "computed reflection also retains private caller identities",
        `function reflectedResult() {
            function reflectedPrivateHelper() { return observeCallerName(); }
            return reflectedPrivateHelper();
        }
        function observeCallerName() {
            var first = "cal" + "lee", second = "call" + "er";
            return arguments[first][second].name;
        }`,
        (context) => {
            assert.equal(context.reflectedResult(), "reflectedPrivateHelper");
        }
    );
    const measured = await test(
        "local optimization shrinks code while preserving public entry points",
        `function calculateProgress(currentPosition, programmeStart, programmeEnd) {
            var boundedProgrammeDuration = programmeEnd - programmeStart;
            var elapsedProgrammeDuration = currentPosition - programmeStart;
            var currentProgrammePercentage = elapsedProgrammeDuration / boundedProgrammeDuration * 100;
            if (false) { throw new Error("unreachable programme branch"); }
            return Math.max(0, Math.min(100, currentProgrammePercentage));
        }`,
        (context) => {
            assert.equal(context.calculateProgress(25, 0, 100), 25);
            assert.equal(context.calculateProgress(-1, 0, 100), 0);
            assert.equal(context.calculateProgress(101, 0, 100), 100);
        }
    );
    assert(measured.report.outputBytes < measured.report.inputBytes / 2);
    assert.deepEqual(measured.report.globalNames, ["calculateProgress"]);
    assert.equal(
        measured.report.outputSha256,
        createHash("sha256").update(measured.code).digest("hex")
    );
    assert.equal(measured.report.outputBytes, Buffer.byteLength(measured.code));
    const first = await optimizeClassic('var channel = "Новости";');
    const second = await optimizeClassic('var channel = "Новости";');
    assert.deepEqual(
        first,
        second,
        "Optimizer output and reports are deterministic"
    );
    assert.equal(
        first.report.inputBytes,
        Buffer.byteLength('var channel = "Новости";')
    );
    const metadata = classicOptimizerMetadata();
    metadata.options.mangle.toplevel = true;
    assert.equal(classicOptimizerMetadata().options.mangle.toplevel, false);
    await assert.rejects(
        optimizeClassic("var modern = () => 1;"),
        /Unexpected token/
    );
    await assert.rejects(optimizeClassic(null), /ES5 source string/);
    console.log("Classic optimizer: " + count + " runtime scenarios passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
