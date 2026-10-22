const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");
const acorn = require("acorn");
const { test } = require("node:test");
const source = fs.readFileSync("src/access/pin-security.ts", "utf8");
const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES5 },
}).outputText;
acorn.parse(code, { ecmaVersion: 5 });
const library = fs.readFileSync("js/vendor/sjcl-pin.js", "utf8");
acorn.parse(library, { ecmaVersion: 5 });
function fixture(native = true) {
    const w = {
        crypto: native
            ? crypto.webcrypto
            : {
                  getRandomValues: crypto.webcrypto.getRandomValues.bind(
                      crypto.webcrypto
                  ),
              },
        setTimeout,
    };
    vm.runInNewContext(library + "\n" + code, { Uint8Array, window: w });
    return w;
}
function create(w, pin = "1234", current = () => true) {
    return new Promise((resolve) =>
        w.__ottPinSecurity.create(pin, current, resolve)
    );
}
function verify(w, pin, value) {
    return new Promise((resolve) =>
        w.__ottPinSecurity.verify(pin, value, () => true, resolve)
    );
}
test("pinned SJCL selected source has its recorded digest and license", () => {
    const manifest = JSON.parse(
        fs.readFileSync("js/vendor/sjcl-pin-source.json")
    );
    assert.equal(
        crypto.createHash("sha256").update(library).digest("hex"),
        manifest.bundle_sha256
    );
    assert.match(
        fs.readFileSync("js/licenses/SJCL-1.0.9.txt", "utf8"),
        /Redistribution and use in source and binary forms/
    );
});
for (const native of [true, false])
    test(
        "real " +
            (native ? "WebCrypto" : "ES5 fallback") +
            " PBKDF2 matches independent Node and SJCL implementations",
        async () => {
            const w = fixture(native),
                start = Date.now();
            const value = await create(w);
            assert.match(
                value,
                /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/
            );
            const [, iterations, salt, digest] = value.split("$");
            assert.equal(
                digest,
                crypto
                    .pbkdf2Sync(
                        "1234",
                        Buffer.from(salt, "hex"),
                        Number(iterations),
                        32,
                        "sha256"
                    )
                    .toString("hex")
            );
            const s = w.__ottPinPrimitives;
            assert.equal(
                digest,
                s.codec.hex.fromBits(
                    s.misc.pbkdf2("1234", s.codec.hex.toBits(salt), 600000, 256)
                )
            );
            assert.equal(await verify(w, "1234", value), true);
            assert.equal(await verify(w, "4321", value), false);
            console.log(
                "Actual host " +
                    (native ? "native" : "fallback") +
                    " create+crosscheck+2verify: " +
                    (Date.now() - start) +
                    " ms"
            );
        }
    );
test("new records have distinct random salts, malformed and excessive-work records reject", async () => {
    const w = fixture();
    const a = await create(w),
        b = await create(w);
    assert.notEqual(a.split("$")[2], b.split("$")[2]);
    for (const input of [
        "1234",
        "*",
        a.replace("600000", "999999999999"),
        a.replace("sha256", "sha1"),
        a + "0",
        a.slice(0, -1),
        "!locked-invalid-pin",
    ])
        assert.equal(await verify(w, "1234", input), false);
});
test("missing/throwing CSPRNG never uses Math.random", async () => {
    for (const random of [
        undefined,
        () => undefined,
        () => new Uint8Array(16),
        () => {
            throw new Error("denied");
        },
    ]) {
        const w = fixture();
        w.crypto = random ? { getRandomValues: random } : {};
        assert.equal(await create(w), null);
    }
});
test("fallback yields and stops obsolete derivation before callback", async () => {
    const w = fixture(false),
        jobs = [];
    w.setTimeout = (fn) => jobs.push(fn);
    let current = true,
        called = false;
    w.__ottPinSecurity.create(
        "1234",
        () => current,
        () => {
            called = true;
        }
    );
    assert.equal(jobs.length, 1);
    jobs.shift()();
    assert.equal(jobs.length, 1);
    current = false;
    jobs.shift()();
    assert.equal(jobs.length, 0);
    assert.equal(called, false);
});

test("invalid native output fails closed and releases the active derivation", async () => {
    const w = fixture();
    const random = crypto.webcrypto.getRandomValues.bind(crypto.webcrypto);
    for (const output of [null, new ArrayBuffer(0), new ArrayBuffer(31)]) {
        w.crypto = {
            getRandomValues: random,
            subtle: {
                deriveBits: () => Promise.resolve(output),
                importKey: () => Promise.resolve({}),
            },
        };
        assert.equal(await create(w), null);
    }
    w.crypto = crypto.webcrypto;
    assert.match(await create(w), /^pbkdf2-sha256\$600000\$/);
});
test("only one derivation runs, and cancellation frees the next attempt", () => {
    const w = fixture(false),
        jobs = [];
    w.setTimeout = (fn) => jobs.push(fn);
    let current = true,
        first = false,
        second = "pending";
    w.__ottPinSecurity.create(
        "1234",
        () => current,
        () => {
            first = true;
        }
    );
    w.__ottPinSecurity.create(
        "1234",
        () => true,
        (value) => {
            second = value;
        }
    );
    assert.equal(jobs.length, 2);
    jobs.shift()(); // Only the first derivation can schedule another chunk.
    jobs.shift()();
    assert.equal(second, null);
    assert.equal(jobs.length, 1);
    current = false;
    jobs.shift()();
    assert.equal(first, false);
    w.__ottPinSecurity.create(
        "1234",
        () => true,
        () => {}
    );
    assert.equal(
        jobs.length,
        1,
        "next attempt obtains the released derivation slot"
    );
});
