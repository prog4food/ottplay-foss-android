const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const { test } = require("node:test");
const manifest = JSON.parse(fs.readFileSync("js/vendor/sjcl-pin-source.json"));
const patched = fs.readFileSync("js/vendor/sjcl-pin.js", "utf8");
const patchBytes = fs.readFileSync("js/vendor/" + manifest.local_patch.path);
const patch = JSON.parse(patchBytes);
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
let original = patched;
for (const operation of [...patch.operations].reverse()) {
    assert.equal(original.split(operation.after).length - 1, operation.count);
    original = original.split(operation.after).join(operation.before);
}
function load(source, typed) {
    const context = vm.createContext({
        Uint32Array: typed ? Uint32Array : undefined,
        window: {},
    });
    vm.runInContext(source, context);
    return context.window.__ottPinPrimitives;
}
function words(value) {
    return {
        keys: Object.keys(value),
        length: value.length,
        values: Array.from(value),
    };
}
test("the explicit word-array patch reverses to the pinned unchanged upstream bundle", () => {
    assert.equal(hash(patchBytes), manifest.local_patch.sha256);
    assert.equal(hash(patched), manifest.bundle_sha256);
    assert.equal(hash(original), manifest.upstream_bundle_sha256);
    assert.equal(
        manifest.upstream_bundle_sha256,
        "b169b8b56384fd678199ffd321ca90467dccc10cd5ba0a268ecd60674205fa74"
    );
});
for (const typed of [true, false]) {
    const a = load(original, typed),
        b = load(patched, typed);
    test(`word/partial-bit array semantics and non-aliasing remain upstream (typed=${typed})`, () => {
        const samples = [[], [0], [0x12345678, -1], [1, 2, 3, 4]];
        for (const bits of [1, 7, 8, 15, 31])
            samples.push([0x12345678, a.bitArray.partial(bits, -1)]);
        const sparse = [1, , 3];
        samples.push(sparse);
        for (const left of samples)
            for (const right of samples) {
                const beforeLeft = words(left),
                    beforeRight = words(right);
                const expected = a.bitArray.concat(left, right),
                    actual = b.bitArray.concat(left, right);
                assert.deepEqual(words(actual), words(expected));
                if (actual.length) actual[0] = 99;
                assert.deepEqual(words(left), beforeLeft);
                assert.deepEqual(words(right), beforeRight);
            }
        for (const input of samples) {
            for (const start of [
                -65, -33, -32, -31, -1, -0.5, 0, 0.5, 1, 7, 31, 32, 33, 63, 64,
                200,
            ]) {
                for (const end of [undefined, 1, 31, 32, 63, 129]) {
                    assert.deepEqual(
                        words(b.bitArray.bitSlice(input, start, end)),
                        words(a.bitArray.bitSlice(input, start, end))
                    );
                }
            }
            for (const length of [
                -1,
                0,
                0.5,
                1,
                7,
                31,
                32,
                33,
                63,
                64,
                65,
                200,
                NaN,
                Infinity,
                -Infinity,
            ]) {
                assert.deepEqual(
                    words(b.bitArray.clamp(input, length)),
                    words(a.bitArray.clamp(input, length))
                );
                if (input.length * 32 < length)
                    assert.equal(b.bitArray.clamp(input, length), input);
            }
            for (const shift of [0, 1, 31, 32, 33, 63, 64])
                for (const out of [[], [123, 456]]) {
                    const expectedOut = out.slice(),
                        actualOut = out.slice();
                    const expected = a.bitArray._shiftRight(
                        input,
                        shift,
                        42,
                        expectedOut
                    );
                    const actual = b.bitArray._shiftRight(
                        input,
                        shift,
                        42,
                        actualOut
                    );
                    assert.deepEqual(words(actual), words(expected));
                    assert.deepEqual(words(actualOut), words(expectedOut));
                    assert.equal(
                        actual === actualOut,
                        expected === expectedOut
                    );
                }
        }
    });
    test(`SHA256 streaming/clone/reset and HMAC match independent Node (typed=${typed})`, () => {
        for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1025]) {
            const bytes = Buffer.alloc(length);
            for (let i = 0; i < length; i++) bytes[i] = i % 256;
            const input = b.codec.hex.toBits(bytes.toString("hex"));
            const expected = crypto
                .createHash("sha256")
                .update(bytes)
                .digest("hex");
            assert.equal(
                b.codec.hex.fromBits(b.hash.sha256.hash(input)),
                expected
            );
            const split = Math.floor(length / 2);
            const state = new b.hash.sha256().update(
                b.codec.hex.toBits(bytes.subarray(0, split).toString("hex"))
            );
            const clone = new b.hash.sha256(state);
            const rest = b.codec.hex.toBits(
                bytes.subarray(split).toString("hex")
            );
            assert.equal(
                b.codec.hex.fromBits(state.update(rest).finalize()),
                expected
            );
            assert.equal(
                b.codec.hex.fromBits(clone.update(rest).finalize()),
                expected
            );
            assert.equal(
                b.codec.hex.fromBits(state.update(input).finalize()),
                expected
            );
            for (const keyLength of [0, 1, 63, 64, 65, 100]) {
                const key = Buffer.alloc(keyLength, 0xa7);
                const hmac = new b.misc.hmac(
                    b.codec.hex.toBits(key.toString("hex"))
                );
                const digest = crypto
                    .createHmac("sha256", key)
                    .update(bytes)
                    .digest("hex");
                assert.equal(b.codec.hex.fromBits(hmac.encrypt(input)), digest);
                assert.equal(b.codec.hex.fromBits(hmac.encrypt(input)), digest);
            }
        }
    });
    test(`PBKDF2 partial/multiple blocks retain upstream results (typed=${typed})`, () => {
        for (const count of [1, 2, 17])
            for (const length of [1, 127, 128, 255, 256, 257, 511, 512, 513]) {
                assert.deepEqual(
                    words(b.misc.pbkdf2("password", "salt", count, length)),
                    words(a.misc.pbkdf2("password", "salt", count, length))
                );
            }
    });
}
test("the complete 600000-iteration production derivation matches independent Node", () => {
    const sjcl = load(patched, true),
        salt = "00112233445566778899aabbccddeeff";
    const result = sjcl.codec.hex.fromBits(
        sjcl.misc.pbkdf2("1234", sjcl.codec.hex.toBits(salt), 600000, 256)
    );
    assert.equal(
        result,
        crypto
            .pbkdf2Sync("1234", Buffer.from(salt, "hex"), 600000, 32, "sha256")
            .toString("hex")
    );
});
