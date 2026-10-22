const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const {
    ARTIFACTS,
    BUDGET,
    PROVIDER_BUDGET,
    TOTAL_BUDGET,
    inspectBundleSets,
    inspectBundles,
    measureBundle,
    writeBundleReport,
} = require("../scripts/classic-size.cjs");
const { CLASSIC_PROVIDER_BUNDLES } = require("../scripts/classic-bundle.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-size-test-"));
const androidOutput = fs.mkdtempSync(
    path.join(os.tmpdir(), "ottplay-size-android-output-")
);
try {
    const source = "var title = 'Программа';";
    const measurement = measureBundle(source, "unicode.js");
    assert.equal(measurement.bytes, Buffer.byteLength(source));
    assert.ok(measurement.bytes > source.length);
    assert.throws(() => measureBundle("", "empty"), /Empty classic bundle/);
    assert.throws(
        () => measureBundle(source, "raw", { bytes: 1, gzipBytes: 1000 }),
        /bytes .* exceeds budget/
    );
    assert.throws(
        () => measureBundle(source, "gzip", { bytes: 1000, gzipBytes: 1 }),
        /gzipBytes .* exceeds budget/
    );
    assert.throws(() => inspectBundles(root), /ENOENT/);
    for (const file of ARTIFACTS) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
    }
    assert.equal(inspectBundles(root).length, 3);
    assert.throws(() => inspectBundleSets(root), /ENOENT/);
    for (const file of ARTIFACTS) {
        for (const kind of Object.keys(CLASSIC_PROVIDER_BUNDLES))
            fs.writeFileSync(
                path.join(root, path.dirname(file), "provider-" + kind + ".js"),
                source
            );
    }
    const sets = inspectBundleSets(root);
    assert.equal(sets.length, 3);
    assert.equal(sets[0].providers.length, 8);
    assert.equal(sets[0].total.bytes, measurement.bytes * 9);
    assert.equal(sets[0].total.gzipBytes, measurement.gzipBytes * 9);
    const extra = path.join(root, "dist/provider-old.js");
    fs.writeFileSync(extra, source);
    assert.throws(() => inspectBundleSets(root), /Unexpected provider bundle/);
    fs.unlinkSync(extra);
    const oversizedSet = path.join(root, "dist/provider-m3u.js");
    // Entry-only growth must not silently relax the existing provider limit.
    const providerBudget = { bytes: 863400, gzipBytes: 268490 };
    assert.deepEqual(PROVIDER_BUDGET, providerBudget);
    const entryOnlyGrowth = "x".repeat(providerBudget.bytes + 1);
    assert.doesNotThrow(() => measureBundle(entryOnlyGrowth, "entry"));
    fs.writeFileSync(oversizedSet, entryOnlyGrowth);
    assert.throws(
        () => inspectBundleSets(root),
        /provider-m3u\.js: bytes .* exceeds budget 863400/
    );
    fs.writeFileSync(oversizedSet, "x".repeat(providerBudget.bytes - 1));
    const additional = path.join(root, "dist/provider-edem.js");
    fs.writeFileSync(
        additional,
        "y".repeat(TOTAL_BUDGET.bytes - providerBudget.bytes)
    );
    assert.throws(
        () => inspectBundleSets(root),
        /complete player bytes .* exceeds budget/
    );
    fs.writeFileSync(oversizedSet, source);
    fs.writeFileSync(additional, source);
    const optimizer = { outputSha256: measurement.sha256 };
    // Android Play ships exactly the four permitted provider families.
    // Check both its retained flat export and the nested Capacitor entry point.
    const playArtifacts = ["play/player.js", "play/dist/player.js"];
    const playKinds = ["m3u", "plex", "stalker", "vportal"];
    for (const file of playArtifacts) {
        const directory = path.join(root, path.dirname(file));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
        for (const kind of playKinds)
            fs.writeFileSync(
                path.join(directory, "provider-" + kind + ".js"),
                source
            );
    }
    const playSets = inspectBundleSets(root, playArtifacts, playKinds);
    assert.equal(playSets.length, 2);
    assert.equal(playSets[0].providers.length, 4);
    assert.equal(playSets[0].total.bytes, measurement.bytes * 5);
    assert.equal(playSets[0].total.gzipBytes, measurement.gzipBytes * 5);
    // Android's configured output may be outside the repository entirely.
    // Both inventories are relative to that output root, not the default dist.
    const androidArtifacts = ["player.js", "dist/player.js"];
    for (const file of androidArtifacts) {
        const directory = path.join(androidOutput, path.dirname(file));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(androidOutput, file), source);
        for (const kind of playKinds)
            fs.writeFileSync(
                path.join(directory, "provider-" + kind + ".js"),
                source
            );
    }
    const config = ts.createSourceFile(
        "vite.config.ts",
        fs.readFileSync(path.join(__dirname, "../vite.config.ts"), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const androidGates = [];
    function findAndroidGate(node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "inspectBundleSets"
        )
            androidGates.push(node.getText(config));
        ts.forEachChild(node, findAndroidGate);
    }
    findAndroidGate(config);
    assert.equal(androidGates.length, 1);
    const inspectAndroid = () =>
        vm.runInNewContext(androidGates[0], {
            __dirname: root,
            inspectBundleSets,
            outDir: androidOutput,
            providerKinds: playKinds,
        });
    const androidSets = inspectAndroid();
    assert.deepEqual(
        Array.from(androidSets, (set) => set.entry),
        androidArtifacts
    );
    assert.equal(androidSets[1].total.bytes, measurement.bytes * 5);
    const externalChunk = path.join(androidOutput, "dist/provider-m3u.js");
    fs.unlinkSync(externalChunk);
    assert.throws(
        inspectAndroid,
        (error) => error.code === "ENOENT" && error.path === externalChunk
    );
    assert.equal(
        writeBundleReport(root, optimizer, [], playArtifacts, playKinds)
            .providerBundles[0].providers.length,
        4
    );
    assert.throws(() => inspectBundleSets(root, playArtifacts), /ENOENT/);
    assert.throws(
        () => inspectBundleSets(root, playArtifacts, ["m3u", "unknown"]),
        /Invalid expected provider bundle kinds/
    );
    assert.throws(
        () => inspectBundleSets(root, playArtifacts, ["m3u", "m3u"]),
        /Invalid expected provider bundle kinds/
    );
    const fullOnly = path.join(root, "play/dist/provider-edem.js");
    fs.writeFileSync(fullOnly, source);
    assert.throws(
        () => inspectBundleSets(root, playArtifacts, playKinds),
        /Unexpected provider bundle/
    );
    fs.unlinkSync(fullOnly);
    const required = path.join(root, "play/dist/provider-stalker.js");
    fs.unlinkSync(required);
    assert.throws(
        () => inspectBundleSets(root, playArtifacts, playKinds),
        /ENOENT/
    );
    fs.writeFileSync(required, source);
    fs.writeFileSync(required, "x".repeat(providerBudget.bytes - 1));
    const otherRequired = path.join(root, "play/dist/provider-m3u.js");
    fs.writeFileSync(
        otherRequired,
        "y".repeat(TOTAL_BUDGET.bytes - providerBudget.bytes)
    );
    assert.throws(
        () => inspectBundleSets(root, playArtifacts, playKinds),
        /complete player bytes .* exceeds budget/
    );
    const report = writeBundleReport(root, optimizer, ["entry.js"]);
    assert.deepEqual(
        JSON.parse(
            fs.readFileSync(
                path.join(root, "build/reports/classic-bundle.json")
            )
        ),
        report
    );
    assert.throws(
        () => writeBundleReport(root, { outputSha256: "stale" }, []),
        /does not match/
    );
    // A previously valid report must never allow an oversized staged artifact.
    fs.writeFileSync(
        path.join(root, ARTIFACTS[2]),
        "x".repeat(BUDGET.bytes + 1)
    );
    assert.throws(() => inspectBundles(root), /dist-mobile.* exceeds budget/);
    assert.throws(
        () => writeBundleReport(root, optimizer, []),
        /dist-mobile.* exceeds budget/
    );
    fs.unlinkSync(path.join(root, ARTIFACTS[1]));
    assert.throws(() => inspectBundles(root), /ENOENT/);
    console.log(
        "PASS classic bundle budgets: bytes, gzip, missing/stale/oversized artifacts"
    );
} finally {
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(androidOutput, { force: true, recursive: true });
}
