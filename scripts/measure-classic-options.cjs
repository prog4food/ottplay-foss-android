#!/usr/bin/env node
// Compare bounded optimizer profiles without rebuilding or changing dist files.
// Refresh the compiled source first: npx --no-install tsc && node scripts/measure-classic-options.cjs
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const { brotliCompressSync, constants, gzipSync } = require("node:zlib");
const { parse } = require("acorn");
const { minify } = require("terser");
const { assembleClassic, CLASSIC_MODULES } = require("./classic-bundle.cjs");
const { classicOptimizerMetadata } = require("./classic-optimizer.cjs");
const { embedPlayerBuildIdentity } = require("./player-build-identity.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = "build/experiments/classic-options";
const REPORT = "build/reports/minify-options.json";
const BOOLEAN_PROBE = `function booleanContract() {
    return { enabled: true, disabled: false };
}`;
const ARGUMENTS_PROBE = `function omitted(value) {
    value = 1;
    return arguments[0];
}
function deleted(value) {
    delete arguments[0];
    value = 2;
    return arguments[0];
}`;

function sha256(source) {
    return createHash("sha256").update(source).digest("hex");
}

function globals(source) {
    const names = new Set();
    const ast = parse(source, { ecmaVersion: 5, sourceType: "script" });
    function visit(node) {
        if (!node || typeof node !== "object") return;
        if (node.type === "FunctionDeclaration") {
            names.add(node.id.name);
            return;
        }
        if (node.type === "FunctionExpression") return;
        if (node.type === "VariableDeclaration") {
            for (const declaration of node.declarations)
                names.add(declaration.id.name);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") visit(value);
        }
    }
    visit(ast);
    return Array.from(names).sort();
}

function candidates() {
    const profiles = [];
    for (const passes of [1, 2, 3, 4, 5])
        profiles.push({ compress: { passes }, name: "passes-" + passes });
    for (const option of ["hoist_funs", "hoist_vars"])
        profiles.push({ compress: { [option]: true }, name: option });
    profiles.push({
        compress: { hoist_funs: true, hoist_vars: true },
        name: "hoist-both",
    });
    for (const passes of [3, 5]) {
        for (const option of ["hoist_funs", "hoist_vars"])
            profiles.push({
                compress: { passes, [option]: true },
                name: "passes-" + passes + "-" + option,
            });
        profiles.push({
            compress: { hoist_funs: true, hoist_vars: true, passes },
            name: "passes-" + passes + "-hoist-both",
        });
    }
    profiles.push({
        compress: { arguments: true },
        diagnostic: true,
        name: "arguments",
    });
    profiles.push({
        compress: { booleans_as_integers: true },
        diagnostic: true,
        name: "diagnostic-booleans-as-integers",
    });
    profiles.push({
        compress: {},
        diagnostic: true,
        format: { inline_script: false },
        name: "diagnostic-external-script-format",
    });
    return profiles;
}

function comparisonOptimizerMetadata() {
    const metadata = classicOptimizerMetadata();
    // Keep the comparison independent of the production pass count and these
    // optional transforms. The report records both complete option profiles.
    Object.assign(metadata.options.compress, {
        arguments: false,
        booleans_as_integers: false,
        hoist_funs: false,
        hoist_vars: false,
        passes: 1,
    });
    return metadata;
}

function optionsFor(candidate) {
    const options = comparisonOptimizerMetadata().options;
    Object.assign(options.compress, candidate.compress);
    Object.assign(options.format, candidate.format);
    return options;
}

async function booleanContract(candidate) {
    const result = await minify(BOOLEAN_PROBE, optionsFor(candidate));
    const context = vm.createContext({});
    vm.runInContext(result.code, context);
    const value = context.booleanContract();
    return {
        disabledType: typeof value.disabled,
        enabledType: typeof value.enabled,
        json: JSON.stringify(value),
        preserved: value.enabled === true && value.disabled === false,
    };
}

async function argumentsContract(candidate) {
    const result = await minify(ARGUMENTS_PROBE, optionsFor(candidate));
    const context = vm.createContext({});
    vm.runInContext(result.code, context);
    const omitted = context.omitted();
    const deleted = context.deleted(1);
    return {
        deleted: { type: typeof deleted, value: String(deleted) },
        omitted: { type: typeof omitted, value: String(omitted) },
        preserved: omitted === undefined && deleted === undefined,
    };
}

function sizes(code) {
    const buffer = Buffer.from(code);
    return {
        brotliBytes: brotliCompressSync(buffer, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
        }).length,
        bytes: buffer.length,
        gzipBytes: gzipSync(buffer, { level: 9 }).length,
    };
}

function readRounds(args) {
    if (!args.length) return 1;
    if (
        args.length !== 2 ||
        args[0] !== "--rounds" ||
        !["1", "2"].includes(args[1])
    )
        throw new Error(
            "Usage: node scripts/measure-classic-options.cjs [--rounds 1|2]"
        );
    return Number(args[1]);
}

async function main() {
    const rounds = readRounds(process.argv.slice(2));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json")));
    const source = embedPlayerBuildIdentity(
        assembleClassic(ROOT, CLASSIC_MODULES).replace(
            /__OTTP_VERSION__/g,
            pkg.version || "local"
        ),
        ROOT
    );
    const inputGlobals = globals(source);
    const metadata = classicOptimizerMetadata();
    const report = {
        candidates: [],
        comparisonBaseline: {
            name: "passes-1",
            optimizer: comparisonOptimizerMetadata(),
        },
        compression: { brotliQuality: 11, gzipLevel: 9 },
        currentOptimizer: metadata,
        input: {
            bytes: Buffer.byteLength(source),
            globalCount: inputGlobals.length,
            modules: CLASSIC_MODULES,
            sha256: sha256(source),
            version: pkg.version || "local",
        },
        interpretation:
            "Size, ES5 syntax and globals checks are not full runtime or device compatibility proof. Diagnostic candidates are not production recommendations.",
        rounds,
        schema: 2,
        toolchain: {
            brotli: process.versions.brotli,
            node: process.versions.node,
            terser: metadata.engineVersion,
            v8: process.versions.v8,
            zlib: process.versions.zlib,
        },
    };
    fs.mkdirSync(path.join(ROOT, OUTPUT), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(ROOT, REPORT)), { recursive: true });
    const profiles = candidates();
    let combinedArguments = false;
    for (const candidate of profiles) {
        const timings = [];
        let code;
        for (let round = 0; round < rounds; round++) {
            const started = performance.now();
            const result = await minify(source, optionsFor(candidate));
            timings.push(Math.round(performance.now() - started));
            assert.equal(typeof result.code, "string");
            if (code !== undefined)
                assert.equal(
                    result.code,
                    code,
                    candidate.name + " changed between rounds"
                );
            code = result.code;
        }
        const outputGlobals = globals(code);
        assert.deepEqual(
            outputGlobals,
            inputGlobals,
            candidate.name + " changed globals"
        );
        const contract = await booleanContract(candidate);
        const argumentsResult = await argumentsContract(candidate);
        if (!candidate.diagnostic) {
            assert.equal(
                contract.preserved,
                true,
                candidate.name + " changed booleans"
            );
            assert.equal(
                argumentsResult.preserved,
                true,
                candidate.name + " changed arguments semantics"
            );
        }
        const artifact = OUTPUT + "/" + candidate.name + ".js";
        fs.writeFileSync(path.join(ROOT, artifact), code);
        const result = {
            compressOverrides: candidate.compress,
            diagnostic: candidate.diagnostic === true,
            formatOverrides: candidate.format || {},
            meanOptimizerMs: Math.round(
                timings.reduce((total, value) => total + value, 0) / rounds
            ),
            name: candidate.name,
            optimizerMs: timings,
            ...sizes(code),
            artifact,
            checks: {
                argumentsContract: argumentsResult,
                booleanContract: contract,
                es5: true,
                globalCount: outputGlobals.length,
                globalsUnchanged: true,
            },
            sha256: sha256(code),
        };
        const baseline = report.candidates[0] || result;
        result.deltaFromBaseline = Object.fromEntries(
            ["bytes", "gzipBytes", "brotliBytes"].map((key) => [
                key,
                result[key] - baseline[key],
            ])
        );
        report.candidates.push(result);
        fs.writeFileSync(
            path.join(ROOT, REPORT),
            JSON.stringify(report, null, 2) + "\n"
        );
        console.log(
            `${candidate.name}: ${result.bytes} bytes; gzip ${result.gzipBytes}; brotli ${result.brotliBytes}; optimizer ${timings.join(", ")} ms`
        );
        if (
            !combinedArguments &&
            report.candidates.length === profiles.length
        ) {
            combinedArguments = true;
            const best = report.candidates
                .filter(
                    (item) =>
                        !item.diagnostic &&
                        !item.compressOverrides.arguments &&
                        item.gzipBytes <= baseline.gzipBytes
                )
                .sort(
                    (a, b) => a.bytes - b.bytes || a.gzipBytes - b.gzipBytes
                )[0];
            profiles.push({
                compress: { ...best.compressOverrides, arguments: true },
                diagnostic: true,
                name: best.name + "-with-arguments",
            });
        }
    }
    console.log("Report: " + REPORT);
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

module.exports = {
    argumentsContract,
    candidates,
    comparisonOptimizerMetadata,
    globals,
    optionsFor,
    sizes,
};
