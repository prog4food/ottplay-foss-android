/* Golden outputs from legacy JS; no archive checkout or native tools needed. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const fixtures = require("./fixtures/legacy-hash-vectors.json");
const file = path.join(__dirname, "../src/utils/encoding.ts");
const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const code = ts.transpileModule(
    ast.statements
        .map((node) => node.getText(ast).replace(/^export\s+/, ""))
        .join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(code, { ecmaVersion: 5 });
for (const withoutImul of [false, true]) {
    const c = vm.createContext({});
    if (withoutImul) vm.runInContext("Math.imul = undefined", c);
    c.window = c;
    vm.runInContext(code, c);
    for (const row of fixtures.strings) {
        assert.equal(c.stripHttpScheme(row.input), row.stripped);
        assert.equal(
            Buffer.from(c.stringToUtf8Bytes(row.input)).toString("hex"),
            row.utf8Hex
        );
        assert.equal(c.murmurhash3_32_gc(row.input, 0), row.murmur0);
        assert.equal(c.murmurhash3_32_gc(row.input, 10), row.murmur10);
        assert.equal(c.xxHash32S(row.input, false, 0), row.xx0);
        assert.equal(c.xxHash32S(row.input, false, 10), row.xx10);
        assert.equal(c.xxHash32Si(row.input), row.xxInsensitive);
        assert.equal(c.xxHash32S(row.input, true), Number(row.xxInsensitive));
    }
    for (const row of fixtures.bytes) {
        const bytes = Array.from(
            { length: row.length },
            (_, index) => (index * 47 + row.length) % 256
        );
        Object.freeze(bytes);
        assert.equal(c.murmurhash3_32(bytes, row.seed), row.murmur);
        assert.equal(c.xxHash32(bytes, row.seed), row.xx);
        assert.equal(
            c.previousPortMurmur32(bytes, row.seed),
            row.previousMurmur
        );
        assert.equal(c.previousPortXxHash32(bytes, row.seed), row.previousXx);
    }
    for (const url of [fixtures.xmltv.url, "http://EPG.test/Feed.xml.gz"]) {
        assert.equal(
            c.xxHash32Si(c.stripHttpScheme(url)),
            fixtures.xmltv.hash,
            "Both URL schemes resolve to the legacy XMLTV source ID"
        );
    }
    assert.equal(
        c.stripHttpScheme("ftp://epg.test/feed.xml.gz"),
        "ftp://epg.test/feed.xml.gz"
    );
    assert.equal(
        c.stripHttpScheme("relative/feed.xml.gz"),
        "relative/feed.xml.gz"
    );

    // The optional migration observer must compare exact same inputs/seeds and not
    // modify the canonical return value or compute historical hashes in normal use.
    const recorded = [];
    c.__ottRecordPortHash = (previous, current) =>
        recorded.push([previous, current]);
    for (const row of fixtures.strings.filter((row) => row.input)) {
        recorded.length = 0;
        assert.equal(c.murmurhash3_32_gc(row.input, 10), row.murmur10);
        assert.equal(c.xxHash32S(row.input, false), row.xx0);
        assert.equal(c.xxHash32Si(row.input), row.xxInsensitive);
        assert.deepEqual(
            recorded,
            [
                [row.previousMurmur10, row.murmur10],
                [row.previousXx0, row.xx0],
                [Number(row.previousInsensitive), Number(row.xxInsensitive)],
            ].filter(([previous, current]) => previous !== current)
        );
    }
    delete c.__ottRecordPortHash;
    c.previousPortMurmur32 = c.previousPortXxHash32 = () => {
        throw new Error(
            "Migration hashes must be dormant without the observer"
        );
    };
    assert.equal(
        c.xxHash32S("abc"),
        fixtures.strings.find((row) => row.input === "abc").xx0
    );
    assert.equal(
        c.murmurhash3_32_gc("abc", 10),
        fixtures.strings.find((row) => row.input === "abc").murmur10
    );
}
console.log(
    "PASS: legacy ASCII/UTF-8/URL hashes, block/tail/seed vectors, stable XMLTV IDs and opt-in migration observer, with and without Math.imul"
);
