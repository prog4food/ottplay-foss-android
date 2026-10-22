// Execute shipped bytes with missing runtime APIs; ES5 syntax alone is not
// evidence that HLS can initialize or transmux on a legacy JavaScript engine.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("acorn");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const polyfills = read("js/runtime-polyfills.js");
const hls = read("js/hls.min.js");
const worker = read("js/hls.worker.js");
const { runtimeVersion } = JSON.parse(read("js/media-runtime.json"));
const workerRuntimeUrl = "./runtime-polyfills.js?v=" + runtimeVersion;
const hlsVersion = require("../package.json").dependencies["hls.js"];

const stripModernApis = `
    Promise = undefined;
    Map = undefined;
    Set = undefined;
    WeakMap = undefined;
    WeakSet = undefined;
    Symbol = undefined;
    Reflect = undefined;
    Array.from = undefined;
    Array.of = undefined;
    delete Array.prototype.includes;
    delete Array.prototype.find;
    delete Array.prototype.findIndex;
    delete Array.prototype.fill;
    delete Array.prototype.copyWithin;
    delete Array.prototype.entries;
    delete Array.prototype.keys;
    delete Array.prototype.values;
    Object.assign = undefined;
    Object.entries = undefined;
    Object.values = undefined;
    Object.fromEntries = undefined;
    Object.setPrototypeOf = undefined;
    delete String.prototype.includes;
    delete String.prototype.startsWith;
    delete String.prototype.endsWith;
    delete String.prototype.repeat;
    delete String.prototype.codePointAt;
    String.fromCodePoint = undefined;
    Number.isFinite = undefined;
    Number.isInteger = undefined;
    Number.isNaN = undefined;
    Number.isSafeInteger = undefined;
    Math.imul = undefined;
    Math.sign = undefined;
    Math.trunc = undefined;
    Math.log2 = undefined;
    Math.log10 = undefined;
    Math.clz32 = undefined;
    [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array].forEach(function (Type) {
        Type.from = undefined;
        Type.of = undefined;
        delete Type.prototype.slice;
        delete Type.prototype.fill;
        delete Type.prototype.includes;
    });
    URL = undefined;
    URLSearchParams = undefined;
    TextEncoder = undefined;
    TextDecoder = undefined;
    queueMicrotask = undefined;
`;

function environment({
    legacy = true,
    workerScope = false,
    workerRuntime = polyfills,
} = {}) {
    const listeners = {};
    const messages = [];
    const imports = [];
    const context = vm.createContext({
        addEventListener(name, listener) {
            (listeners[name] ||= []).push(listener);
        },
        clearInterval,
        clearTimeout,
        console,
        location: {
            href: "https://legacy.test/player/",
            origin: "https://legacy.test",
            protocol: "https:",
        },
        navigator: { userAgent: "Legacy ES5 runtime fixture" },
        performance: { now: () => performance.now() },
        removeEventListener(name, listener) {
            listeners[name] = (listeners[name] || []).filter(
                (entry) => entry !== listener
            );
        },
        setInterval,
        setTimeout,
        TextDecoder,
        TextEncoder,
        URL,
        URLSearchParams,
    });
    context.self = context;
    if (!workerScope) context.window = context;
    else {
        context.importScripts = function (url) {
            imports.push(url);
            assert.equal(url, workerRuntimeUrl);
            assert.equal(arguments.length, 1);
            assert.equal(
                (listeners.message || []).length,
                0,
                "Runtime import must finish before upstream initialization"
            );
            if (typeof workerRuntime === "function") workerRuntime();
            else run(workerRuntime, context, url);
        };
        context.postMessage = function (message) {
            messages.push(message);
        };
    }
    if (legacy) vm.runInContext(stripModernApis, context);
    return {
        context,
        dispatch(data) {
            for (const listener of listeners.message || []) listener({ data });
        },
        imports,
        listeners,
        messages,
    };
}

function run(code, context, filename) {
    return vm.runInContext(code, context, { filename, timeout: 10000 });
}

function checkStandardApis(context) {
    const observed = run(
        `(function () {
        var objectKey = {};
        var frozenKey = Object.freeze({});
        var map = new Map([[objectKey, 7], [NaN, 8], [frozenKey, 9]]);
        var set = new Set([1, 1, NaN, NaN, objectKey]);
        var weak = new WeakMap([[frozenKey, 10]]);
        var bytes = Uint8Array.from([0, 128, 255]);
        var symbol = Symbol('private');
        var keyed = {}; keyed[symbol] = 12;
        return JSON.stringify({
            array: Array.from(new Set([1, 2, 1])),
            includesNaN: [1, NaN].includes(NaN),
            map: [map.get(objectKey), map.get(NaN), map.get(frozenKey), map.size],
            set: [set.size, set.has(objectKey), set.has(NaN)],
            weak: weak.get(frozenKey),
            entries: Object.entries({ a: 1, b: 2 }),
            bytes: Array.from(bytes.slice(1)),
            typedIncludes: bytes.includes(255),
            fill: Array.from(Uint8Array.of(1, 2, 3).fill(4, 1)),
            symbol: [keyed[symbol], Object.keys(keyed).length],
            unicode: String.fromCodePoint(128578).codePointAt(0),
            strings: ['abcdef'.startsWith('abc'), 'abcdef'.endsWith('def'),
                'abcdef'.includes('cd')],
            numbers: [Math.imul(0xffffffff, 5), Number.isNaN(NaN),
                Number.isFinite('1'), Math.trunc(-1.5)]
        });
    })()`,
        context,
        "legacy standard API behavior"
    );
    assert.deepEqual(JSON.parse(observed), {
        array: [1, 2],
        bytes: [128, 255],
        entries: [
            ["a", 1],
            ["b", 2],
        ],
        fill: [1, 4, 4],
        includesNaN: true,
        map: [7, 8, 9, 3],
        numbers: [-5, true, false, -1],
        set: [3, true, true],
        strings: [true, true, true],
        symbol: [12, 0],
        typedIncludes: true,
        unicode: 128578,
        weak: 10,
    });
}

async function checkPromise(context) {
    const result = await run(
        `(function () {
        var order = [];
        var promise = Promise.resolve({ then: function (resolve) { resolve(3); } })
            .then(function (value) { order.push('then'); return value; });
        order.push('sync');
        return Promise.all([promise, Promise.resolve(4)]).then(function (values) {
            return Promise.reject('expected').catch(function (reason) {
                return Promise.resolve().finally(function () {
                    order.push('finally');
                }).then(function () {
                    return JSON.stringify({ values: values, reason: reason, order: order });
                });
            });
        });
    })()`,
        context,
        "legacy Promise behavior"
    );
    assert.deepEqual(JSON.parse(result), {
        order: ["sync", "then", "finally"],
        reason: "expected",
        values: [3, 4],
    });
}

function checkWebApis(context) {
    const result = run(
        `(function () {
        var text = 'A\\u00e9\\ud83d\\ude42';
        var encoded = new TextEncoder().encode(text);
        var url = new URL('../seg.ts?token=a%20b', 'https://media.test/live/main.m3u8');
        return JSON.stringify({
            encoded: Array.from(encoded),
            url: url.href,
            query: new URLSearchParams('a=1&a=2&space=a+b').getAll('a'),
            space: new URLSearchParams('space=a+b').get('space')
        });
    })()`,
        context,
        "legacy web API behavior"
    );
    assert.deepEqual(JSON.parse(result), {
        encoded: [65, 195, 169, 240, 159, 153, 130],
        query: ["1", "2"],
        space: "a b",
        url: "https://media.test/seg.ts?token=a%20b",
    });
}

function checkNativePreservation() {
    const { context } = environment({ legacy: false });
    run(
        `var original = {
        promise: Promise, map: Map, set: Set, symbol: Symbol,
        arrayFrom: Array.from, objectAssign: Object.assign,
        uint8: Uint8Array, url: URL, encoder: TextEncoder, decoder: TextDecoder
    };`,
        context,
        "native references"
    );
    run(polyfills, context, "runtime-polyfills.js (native)");
    assert.equal(
        run(
            `original.promise === Promise && original.map === Map &&
        original.set === Set && original.symbol === Symbol &&
        original.arrayFrom === Array.from && original.objectAssign === Object.assign &&
        original.uint8 === Uint8Array && original.url === URL &&
        original.encoder === TextEncoder && original.decoder === TextDecoder`,
            context,
            "native identity"
        ),
        true,
        "Conforming native APIs stay intact"
    );
}

function checkHls(context) {
    run(hls, context, "hls.min.js");
    assert.equal(run("Hls.version", context), hlsVersion);
    assert.equal(
        run("Hls.isSupported()", context),
        false,
        "JavaScript polyfills must not pretend to provide MediaSource"
    );
    run(
        "var instance = new Hls({ enableWorker: false }); instance.destroy();",
        context,
        "real Hls initialization and destruction"
    );
    assert.equal(run("typeof MediaSource", context), "undefined");
    assert.equal(run("typeof SourceBuffer", context), "undefined");
}

function checkWorkerTransmux(workerEnv, config) {
    const { context, dispatch, messages, listeners } = workerEnv;
    assert.equal(run("typeof window", context), "undefined");
    assert.equal(run("typeof document", context), "undefined");
    assert.equal(
        (listeners.message || []).length,
        1,
        "The shipped worker must register the actual upstream message handler"
    );
    dispatch({
        cmd: "init",
        config,
        id: "main",
        instanceNo: 0,
        typeSupported: { mp3: true, mp4: true, mpeg: true },
    });
    assert(messages.some((message) => message.event === "init"));
    dispatch({
        cmd: "configure",
        config: {
            audioCodec: "mp4a.40.2",
            defaultInitPts: null,
            duration: 2,
            videoCodec: "avc1.42e01e",
        },
        instanceNo: 0,
    });
    const bytes = fs.readFileSync(
        path.join(__dirname, "fixtures/media-runtime/segment00.ts")
    );
    context.fixtureBytes = Array.from(bytes);
    const data = run("Uint8Array.from(fixtureBytes).buffer", context);
    delete context.fixtureBytes;
    const chunkMeta = {
        buffering: { audio: {}, audiovideo: {}, video: {} },
        duration: 2,
        id: 1,
        iframe: false,
        level: 0,
        part: -1,
        partial: false,
        size: bytes.length,
        sn: 0,
        transmuxing: {},
    };
    dispatch({
        chunkMeta,
        cmd: "demux",
        data,
        decryptdata: null,
        instanceNo: 0,
        state: {
            accurateTimeOffset: true,
            contiguous: false,
            discontinuity: true,
            initSegmentChange: true,
            timeOffset: 0,
            trackSwitch: true,
        },
    });
    dispatch({ chunkMeta, cmd: "flush", instanceNo: 0 });
    const errors = messages.filter((message) => message.event === "hlsError");
    assert.deepEqual(
        errors,
        [],
        "The actual MPEG-TS fixture must transmux without errors"
    );
    const results = messages
        .filter((message) => message.event === "transmuxComplete")
        .map((message) => message.data.remuxResult);
    const video = results.find((result) => result.video)?.video;
    const audio = results.find((result) => result.audio)?.audio;
    assert(
        video && audio,
        "The real worker must emit both H.264 and AAC media"
    );
    for (const track of [video, audio]) {
        assert(track.nb > 0, "Transmuxed track must contain media samples");
        assert.equal(
            Buffer.from(track.data1).subarray(4, 8).toString(),
            "moof"
        );
        assert.equal(
            Buffer.from(track.data2).subarray(4, 8).toString(),
            "mdat"
        );
    }
    assert(video.endPTS > video.startPTS);
    assert(audio.endPTS > audio.startPTS);
}

function checkWorkerBootstrapFailures() {
    const expectedVersion =
        "self.__ottMediaRuntimeVersion = " +
        JSON.stringify(runtimeVersion) +
        ";";
    const failures = [
        ["empty runtime", ""],
        ["missing ready marker", expectedVersion],
        [
            "false ready marker",
            expectedVersion + "self.__ottRuntimePolyfillsReady = false;",
        ],
        [
            "non-boolean ready marker",
            expectedVersion + "self.__ottRuntimePolyfillsReady = 1;",
        ],
        ["missing version", "self.__ottRuntimePolyfillsReady = true;"],
        [
            "stale runtime version",
            'self.__ottRuntimePolyfillsReady = true; self.__ottMediaRuntimeVersion = "old";',
        ],
    ];
    for (const [name, workerRuntime] of failures) {
        const env = environment({ workerRuntime, workerScope: true });
        assert.throws(
            () => run(worker, env.context, name),
            /OTT-play worker runtime mismatch/,
            name
        );
        assert.deepEqual(env.imports, [workerRuntimeUrl], name);
        assert.deepEqual(env.messages, [], name + " must not report init");
        assert.equal((env.listeners.message || []).length, 0, name);
    }
    // Fetch/CSP/MIME and imported-script execution errors propagate unchanged;
    // none may continue into an apparently working unpolyfilled upstream worker.
    const unavailable = new Error("unavailable runtime");
    for (const [name, workerRuntime, validate] of [
        [
            "unavailable runtime",
            () => {
                throw unavailable;
            },
            (error) => error === unavailable,
        ],
        [
            "runtime execution error after ready markers",
            expectedVersion +
                'self.__ottRuntimePolyfillsReady = true; throw new Error("fixture runtime execution failed");',
            /fixture runtime execution failed/,
        ],
    ]) {
        const env = environment({
            workerRuntime,
            workerScope: true,
        });
        assert.throws(() => run(worker, env.context, name), validate);
        assert.deepEqual(env.imports, [workerRuntimeUrl]);
        assert.deepEqual(env.messages, []);
        assert.equal((env.listeners.message || []).length, 0);
    }
}

async function main() {
    for (const [name, code] of [
        ["runtime-polyfills.js", polyfills],
        ["hls.min.js", hls],
        ["hls.worker.js", worker],
    ])
        parse(code, { ecmaVersion: 5, sourceType: "script" });

    // This negative control must fail with real vendor code, otherwise this
    // fixture could silently stop exercising missing-API failures.
    assert.throws(
        () => run(hls, environment().context, "unpolyfilled Hls"),
        /from|Map|Set|constructor|undefined/,
        "Unpolyfilled legacy Hls must fail"
    );

    checkNativePreservation();
    const mainEnv = environment();
    run(polyfills, mainEnv.context, "runtime-polyfills.js (legacy main)");
    checkStandardApis(mainEnv.context);
    checkWebApis(mainEnv.context);
    await checkPromise(mainEnv.context);
    checkHls(mainEnv.context);

    checkWorkerBootstrapFailures();
    // A fresh worker never inherits window's patched built-ins. Its synchronous
    // import must install the complete runtime before untouched upstream code.
    const workerEnv = environment({ workerScope: true });
    assert.equal(run("typeof Promise", workerEnv.context), "undefined");
    run(worker, workerEnv.context, "hls.worker.js (legacy worker)");
    assert.deepEqual(workerEnv.imports, [workerRuntimeUrl]);
    assert.equal(workerEnv.context.__ottRuntimePolyfillsReady, true);
    assert.equal(workerEnv.context.__ottMediaRuntimeVersion, runtimeVersion);
    for (const file of ["index.html", "src-tauri/pip/pip.html"])
        assert(
            read(file).includes(
                "js/runtime-polyfills.js?v=" + runtimeVersion + '"'
            )
        );
    checkStandardApis(workerEnv.context);
    checkWebApis(workerEnv.context);
    await checkPromise(workerEnv.context);
    checkWorkerTransmux(
        workerEnv,
        run("JSON.stringify(Hls.DefaultConfig)", mainEnv.context)
    );
    console.log(
        "OK: shipped ES5 polyfills, native preservation, real Hls initialization, isolated worker and MPEG-TS transmux"
    );
}

const deadline = setTimeout(() => {
    console.error(
        "Media runtime test timed out; a Promise or worker may never have settled"
    );
    process.exit(1);
}, 15000);
main()
    .then(() => clearTimeout(deadline))
    .catch((error) => {
        clearTimeout(deadline);
        console.error(error);
        process.exitCode = 1;
    });
