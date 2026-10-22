const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");

const source = fs.readFileSync(
    path.join(__dirname, "../src/polyfills/runtime.ts"),
    "utf8"
);
const code = ts
    .transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
acorn.parse(code, { ecmaVersion: 5 });

// A worker has self, but neither window nor document. Old workers lack globalThis.
const worker = vm.createContext({});
vm.runInContext(
    "var self = this; globalThis = undefined; var originalDateGetter = Date.prototype.getHours;",
    worker
);
vm.runInContext(code, worker);
assert.equal(vm.runInContext("typeof window", worker), "undefined");
assert.equal(vm.runInContext("typeof document", worker), "undefined");
assert.equal(vm.runInContext("typeof TextEncoder", worker), "function");
assert.equal(vm.runInContext("typeof performance.now()", worker), "number");
assert.equal(
    vm.runInContext("Date.prototype.getHours === originalDateGetter", worker),
    true,
    "The shared worker runtime must not install application timezone behavior"
);

// Compare byte output and partial writes against the platform implementation.
const native = new TextEncoder();
const encoder = new worker.TextEncoder();
const vectors = [
    "",
    "ASCII\u0000",
    "caf\u00e9 \u20ac",
    "\u041f\u0440\u0438\u0432\u0435\u0442",
    "\ud83d\ude00",
    "\ud800",
    "\udfff",
    "\ud800A\udfff",
    "\ud800\ud800\udc00\udc00",
    "\udbff\udfff",
    "\ufeff\u007f\u0080\u07ff\u0800\uffff",
];
for (const input of vectors) {
    const expected = native.encode(input);
    const actual = encoder.encode(input);
    assert.deepEqual(Array.from(actual), Array.from(expected), input);
    assert.equal(actual.buffer.byteLength, expected.buffer.byteLength);
    for (let length = 0; length <= expected.length + 2; length++) {
        const expectedBytes = new Uint8Array(length).fill(0xaa);
        const actualBytes = new Uint8Array(length).fill(0xaa);
        const expectedResult = native.encodeInto(input, expectedBytes);
        const actualResult = encoder.encodeInto(input, actualBytes);
        assert.equal(actualResult.read, expectedResult.read, input);
        assert.equal(actualResult.written, expectedResult.written, input);
        assert.deepEqual(
            Array.from(actualBytes),
            Array.from(expectedBytes),
            input
        );
    }
}
for (const input of [undefined, null, false, 42]) {
    assert.deepEqual(
        Array.from(encoder.encode(input)),
        Array.from(native.encode(input))
    );
}
assert.equal(encoder.encoding, "utf-8");
assert.throws(() => encoder.encode(Symbol("invalid")), { name: "TypeError" });
assert.throws(() => encoder.encodeInto("x", []), { name: "TypeError" });
assert.throws(() => encoder.encodeInto("x", new Uint8ClampedArray(1)), {
    name: "TypeError",
});
assert.throws(() => encoder.encodeInto("x"), { name: "TypeError" });
assert.throws(() => worker.TextEncoder(), { name: "TypeError" });

const installedEncoder = worker.TextEncoder;
const installedNow = worker.performance.now;
vm.runInContext(code, worker);
assert.equal(worker.TextEncoder, installedEncoder);
assert.equal(worker.performance.now, installedNow);

// Keep native implementations intact, while completing an older native encoder.
const nativeNow = () => 42;
const modern = vm.createContext({
    performance: { now: nativeNow },
    TextEncoder,
});
vm.runInContext(code, modern);
assert.equal(modern.TextEncoder, TextEncoder);
assert.equal(modern.performance.now, nativeNow);
const partial = vm.createContext({});
vm.runInContext(
    "function TextEncoder() {} TextEncoder.prototype.encode = function () { return 'native'; }; var originalEncode = TextEncoder.prototype.encode;",
    partial
);
vm.runInContext(code, partial);
assert.equal(
    vm.runInContext("TextEncoder.prototype.encode === originalEncode", partial),
    true
);
const partialResult = new partial.TextEncoder().encodeInto(
    "\ud83d\ude00",
    new Uint8Array(4)
);
assert.equal(partialResult.read, 2);
assert.equal(partialResult.written, 4);

// The fallback remains nondecreasing when the system clock moves backwards.
const clock = vm.createContext({ ticks: 1000 });
vm.runInContext(
    "var self = this; Date = function () {}; Date.prototype.getTime = function () { return ticks; };",
    clock
);
vm.runInContext(code, clock);
clock.ticks = 1010;
assert.equal(clock.performance.now(), 10);
clock.ticks = 1005;
assert.equal(clock.performance.now(), 10);
clock.ticks = 1020;
assert.equal(clock.performance.now(), 20);

console.log(
    "PASS: ES5 worker web APIs, native preservation, UTF-8 replacement and encodeInto boundaries"
);
