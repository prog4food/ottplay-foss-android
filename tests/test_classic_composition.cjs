const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { minify } = require("terser");
const {
    argumentsFor,
    attributeModules,
    measureSource,
    optimizeComposition,
} = require("../scripts/measure-classic-composition.cjs");
const { optimizeClassic } = require("../scripts/classic-optimizer.cjs");
const {
    CLASSIC_PLAYER_NAME_POLICY,
} = require("../scripts/classic-function-names.cjs");
const {
    applyPlayerBuildIdentity,
    createPlayerBuildIdentity,
    embedPlayerBuildIdentity,
} = require("../scripts/player-build-identity.cjs");
const { testReleaseOverlay } = require("./test_player_build_identity.cjs");

async function testBuildIdentity() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ott-composition-"));
    try {
        const git = (...args) =>
            execFileSync("git", args, {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        const commit = () => {
            git("add", "source");
            git(
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "Fixture"
            );
        };
        git("init", "-q");
        fs.writeFileSync(path.join(root, "source"), "initial");
        commit();
        const version = "1.2.3+fixture";
        const linked = {
            parts: [
                {
                    code: 'function identity() { return { buildId: "__OTTP_BUILD_ID__", sourceRevision: String("__OTTP_SOURCE_REVISION__") || null, version: version }; }',
                    file: "first.js",
                },
                {
                    code: 'window.result = { identity: identity(), copy: "__OTTP_BUILD_ID__", label: "Привет 😀" };',
                    file: "second.js",
                },
            ],
            prelude: 'var version = "__OTTP_VERSION__";\n',
        };
        const source = (
            linked.prelude + linked.parts.map((part) => part.code).join("\n")
        ).replace(/__OTTP_VERSION__/g, version);
        const identity = createPlayerBuildIdentity(source, root);
        assert.equal(identity.sourceRevision, git("rev-parse", "HEAD"));
        const produce = async (input) =>
            (await optimizeClassic(input, CLASSIC_PLAYER_NAME_POLICY)).code;
        const clean = await produce(embedPlayerBuildIdentity(source, root));
        const measured = await optimizeComposition(
            linked,
            version,
            root,
            clean
        );
        assert.equal(measured.code, clean);
        const modules = attributeModules(clean, measured.decoded_map);
        assert(modules.find((entry) => entry.module === "first.js").bytes > 0);
        assert(
            modules.find((entry) => entry.module === "second.js").tokenBytes
                .strings >= Buffer.byteLength('"Привет 😀"'),
            "Identity substitution preserves UTF-8 source-map attribution"
        );
        assert.equal(
            modules.reduce((sum, entry) => sum + entry.bytes, 0),
            Buffer.byteLength(clean)
        );

        // The production build can dirty a tracked generated file after embedding
        // its revision. Attribution must still use the original full-source ID.
        fs.appendFileSync(path.join(root, "source"), " generated");
        assert.equal(
            createPlayerBuildIdentity(source, root).sourceRevision,
            ""
        );
        assert.equal(
            (await optimizeComposition(linked, version, root, clean)).code,
            clean
        );
        const dirty = await produce(embedPlayerBuildIdentity(source, root));
        assert.equal(
            (await optimizeComposition(linked, version, root, dirty)).code,
            dirty
        );

        for (const invalid of [
            { ...identity, sourceRevision: "f".repeat(40) },
            { ...identity, buildId: "bundle-" + "e".repeat(64) },
        ]) {
            const forged = await produce(
                applyPlayerBuildIdentity(source, invalid)
            );
            await assert.rejects(
                optimizeComposition(linked, version, root, forged),
                /Composition input does not match/,
                "Arbitrary embedded claims cannot replace current HEAD or the full-source digest"
            );
        }
        await assert.rejects(
            optimizeComposition(
                {
                    ...linked,
                    prelude: linked.prelude + "window.changed = true;\n",
                },
                version,
                root,
                clean
            ),
            /Composition input does not match/
        );

        commit();
        assert.notEqual(git("rev-parse", "HEAD"), identity.sourceRevision);
        assert.equal(
            (await optimizeComposition(linked, version, root, dirty)).code,
            dirty
        );
        await assert.rejects(
            optimizeComposition(linked, version, root, clean),
            /Composition input does not match/,
            "A previous HEAD is not accepted as the current clean revision"
        );
    } finally {
        fs.rmSync(root, { force: true, recursive: true });
    }
}

async function main() {
    const source =
        'function greet(value) { return "Привет 😀" + value; }\n// comment\nvar result = greet(2);';
    const measured = measureSource(source);
    assert.equal(measured.bytes, Buffer.byteLength(source));
    assert.equal(measured.functions, 1);
    assert(
        measured.bytes > source.length,
        "measure UTF-8 bytes, not UTF-16 positions"
    );
    assert.equal(
        Object.values(measured.tokenBytes).reduce(
            (sum, value) => sum + value,
            0
        ),
        measured.bytes
    );
    assert(measured.tokenBytes.spacing > 0);
    assert(measured.gzipBytes > 0);
    assert.match(measured.sha256, /^[a-f0-9]{64}$/);

    const emitted = await minify(
        {
            "first.js": 'function greet(value) { return "Привет 😀" + value; }',
            "second.js": "window.result = greet(2);",
        },
        {
            compress: false,
            ecma: 5,
            format: { beautify: true },
            mangle: false,
            sourceMap: { asObject: true },
        }
    );
    const modules = attributeModules(emitted.code, emitted.decoded_map);
    const first = modules.find((entry) => entry.module === "first.js");
    const second = modules.find((entry) => entry.module === "second.js");
    assert.equal(first.functions, 1);
    assert.equal(second.functions, 0);
    assert(first.tokenBytes.strings >= Buffer.byteLength('"Привет 😀"'));
    assert(second.tokenBytes.identifiers > 0);
    assert.equal(
        modules.reduce((sum, entry) => sum + entry.bytes, 0),
        Buffer.byteLength(emitted.code)
    );
    assert(
        modules.find((entry) => entry.module === "<unmapped>").bytes > 0,
        "unmapped line breaks are counted explicitly"
    );

    const partial = attributeModules("var x=1;", {
        mappings: [[[4, 0, 0, 0], [5]]],
        sources: ["partial.js"],
    });
    assert.equal(
        partial.find((entry) => entry.module === "partial.js").bytes,
        1
    );
    assert.equal(
        partial.find((entry) => entry.module === "<unmapped>").bytes,
        7
    );
    assert.deepEqual(attributeModules("", { mappings: [], sources: [] }), []);
    assert.throws(() => attributeModules("x", null), /decoded source map/);
    assert.throws(() =>
        attributeModules("x", {
            mappings: [[[2, 0, 0, 0]]],
            sources: ["bad.js"],
        })
    );
    assert.deepEqual(argumentsFor([]), {
        comparison: undefined,
        output: "build/reports/classic-composition.json",
    });
    assert.deepEqual(
        argumentsFor(["--compare", "reference.js", "--output", "result.json"]),
        { comparison: "reference.js", output: "result.json" }
    );
    assert.throws(() => argumentsFor(["--compare"]), /Usage:/);
    assert.throws(() => argumentsFor(["--unknown", "file"]), /Usage:/);
    await testBuildIdentity();
    testReleaseOverlay();
    console.log(
        "Classic composition: UTF-8 accounting, source maps, build identity, function attribution and arguments passed"
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
