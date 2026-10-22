const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("acorn");
const ts = require("typescript");
const { optimizeClassic } = require("../scripts/classic-optimizer.cjs");
const {
    CLASSIC_PLAYER_NAME_POLICY,
} = require("../scripts/classic-function-names.cjs");

const modes = [
    ["compress", "decompress"],
    ["compressToBase64", "decompressFromBase64"],
    ["compressToUTF16", "decompressFromUTF16"],
    ["compressToEncodedURIComponent", "decompressFromEncodedURIComponent"],
    ["compressToUint8Array", "decompressFromUint8Array"],
];
function corpus() {
    let seed = 3917652;
    function random() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    }
    const inputs = [
        "",
        "a",
        "aaaaa",
        "ababab",
        "__proto__",
        "constructor",
        "toString",
        "Привет 📺 東京",
        "\u0000\u0001\ud800\udfff\uffff",
    ];
    for (let round = 0; round < 160; round++) {
        const alphabet = [65536, 2, 256, 96][round % 4];
        let text = "";
        for (let i = random() % 1025; i > 0; i--)
            text += String.fromCharCode(random() % alphabet);
        inputs.push(text);
    }
    // Dictionary widths cross several bit boundaries on both repetitive and
    // nonrepetitive data; include every UTF-16 code unit without UTF-8 repair.
    let units = "";
    for (let i = 0; i < 65536; i++) units += String.fromCharCode(i);
    inputs.push(
        units,
        "channel=Новости📺&url=https://stream.test/live;".repeat(2500)
    );
    const malformed = [
        "",
        "\u0000",
        "\u4000",
        "\uffff",
        " ",
        "=",
        "not a stream",
    ];
    for (let round = 0; round < 200; round++) {
        let text = "";
        for (let i = random() % 40; i > 0; i--)
            text += String.fromCharCode(random() & 65535);
        malformed.push(text);
    }
    return { inputs, malformed };
}
function normalize(value) {
    return value &&
        Object.prototype.toString.call(value) === "[object Uint8Array]"
        ? Array.from(value)
        : value;
}
function capture(callback) {
    try {
        return { value: normalize(callback()) };
    } catch (error) {
        return { error: error.name + ":" + error.message };
    }
}
function digest(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function observations(context) {
    const { inputs, malformed } = corpus();
    const encoded = [];
    const decoded = [];
    assert.equal(context.decompress(null), "");
    assert.equal(context.decompress(""), null);
    assert.equal(context.decompress("\u0000"), "");
    assert.equal(context.decompress("\uffff"), null);
    assert.equal(context.decompressFromBase64("not a stream"), null);
    assert.throws(() => context.decompressFromUint8Array(new Uint8Array([0])), {
        name: "RangeError",
    });
    for (const [encode, decode] of modes) {
        assert.equal(context[encode].length, 1);
        assert.equal(context[decode].length, 1);
        const outputs = [];
        for (const input of inputs) {
            const output = context[encode](input);
            outputs.push(normalize(output));
            assert.equal(
                context[decode](output),
                input,
                encode + " round trip"
            );
        }
        encoded.push([encode, digest(outputs)]);
        const invalid =
            decode === "decompressFromUint8Array"
                ? [
                      new Uint8Array([]),
                      new Uint8Array([0]),
                      new Uint8Array([0, 0]),
                      new Uint8Array([255, 255, 0]),
                  ]
                : malformed;
        decoded.push([
            decode,
            digest(
                [null, undefined, ...invalid].map((value) =>
                    capture(() => context[decode](value))
                )
            ),
        ]);
        assert.equal(context[encode](null).length, 0);
        assert.equal(context[encode](undefined).length, 0);
    }
    const traces = [];
    assert.equal(context._compress.length, 3);
    assert.equal(context._decompress.length, 3);
    for (const bits of [1, 3, 6, 8, 15, 16]) {
        for (const input of inputs.slice(0, 20)) {
            const writes = [];
            const output = context._compress(input, bits, (value) => {
                writes.push(value);
                return String.fromCharCode(value);
            });
            const reads = [];
            const value = context._decompress(
                output.length,
                2 ** (bits - 1),
                (index) => {
                    reads.push(index);
                    return output.charCodeAt(index);
                }
            );
            assert.equal(value, input);
            traces.push([writes, output, reads, value]);
        }
    }
    // Preserve reader overrun/error behavior on truncated wire values, including
    // the callback indexes and output flush immediately before a thrown error.
    const wire = context.compress("Привет abcabcabc 📺 ".repeat(20));
    for (let length = 0; length <= wire.length; length++) {
        const reads = [];
        const value = capture(() =>
            context._decompress(length, 32768, (index) => {
                reads.push(index);
                return wire.charCodeAt(index);
            })
        );
        traces.push([length, reads, value]);
    }
    for (const stop of [1, 3, 7]) {
        const writes = [];
        const encodedValue = capture(() =>
            context._compress("Привет abcabcabc 📺 ".repeat(20), 6, (value) => {
                writes.push(value);
                if (writes.length === stop) throw new Error("output stopped");
                return String.fromCharCode(value);
            })
        );
        const reads = [];
        const decodedValue = capture(() =>
            context._decompress(wire.length, 32768, (index) => {
                reads.push(index);
                if (reads.length === stop) throw new Error("input stopped");
                return wire.charCodeAt(index);
            })
        );
        traces.push([writes, encodedValue, reads, decodedValue]);
    }
    const uri = context.compressToEncodedURIComponent(
        "x".repeat(200) + "Привет📺"
    );
    assert.equal(
        context.decompressFromEncodedURIComponent(uri.replace(/\+/g, " ")),
        "x".repeat(200) + "Привет📺"
    );
    return { callbackTrace: digest(traces), encoded, malformed: decoded };
}
function compile(source) {
    return ts
        .transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
}
function load(code) {
    parse(code, { ecmaVersion: 5 });
    const context = vm.createContext({});
    vm.runInContext(code, context);
    return context;
}
function assertLiteralLookupOrder(context) {
    const stringType = vm.runInContext("String", context);
    const descriptor = Object.getOwnPropertyDescriptor(
        stringType,
        "fromCharCode"
    );
    // The reader callback can replace (or make a getter throw for) the method
    // used by the following literal conversion. Cover first and later literals.
    for (const input of ["Ā", "AĀ"]) {
        const wire = context.compress(input);
        for (const fail of [false, true]) {
            const trace = [];
            try {
                const decoded = capture(() =>
                    context._decompress(wire.length, 32768, (index) => {
                        trace.push(index);
                        if (index === 1)
                            Object.defineProperty(stringType, "fromCharCode", {
                                configurable: true,
                                get() {
                                    trace.push("get");
                                    if (fail) throw new Error("getter stopped");
                                    return function () {
                                        return "X";
                                    };
                                },
                            });
                        return wire.charCodeAt(index);
                    })
                );
                assert.deepEqual(
                    decoded,
                    fail
                        ? { error: "Error:getter stopped" }
                        : { value: input === "Ā" ? "X" : "AX" }
                );
                assert.deepEqual(
                    trace,
                    !fail && input === "AĀ" ? [0, 1, "get", 2] : [0, 1, "get"]
                );
            } finally {
                Object.defineProperty(stringType, "fromCharCode", descriptor);
            }
        }
    }
}
function assertLzWire(context) {
    // These digests were captured from the pre-refactor codec; round trips alone
    // would miss a wire-format change shared by the encoder and decoder.
    const expected = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, "fixtures/lzstring-wire.json"),
            "utf8"
        )
    );
    assert.deepEqual(observations(context), expected);
    assertLiteralLookupOrder(context);
}
async function main() {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/utils/lzstring.ts"),
        "utf8"
    );
    const original = compile(source);
    const optimized = await optimizeClassic(
        original,
        CLASSIC_PLAYER_NAME_POLICY
    );
    for (const code of [original, optimized.code]) assertLzWire(load(code));
    console.log(
        "LZ-String: all encodings, UTF-16 wire goldens, corruption and callback traces PASS"
    );
}
if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { assertLzWire, compile, load, observations };
