#!/usr/bin/env node
// Attribute the emitted player to linked modules using the production optimizer.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gzipSync } = require("node:zlib");
const { parse, tokenizer } = require("acorn");
const { minify } = require("terser");
const {
    assembleClassic,
    CLASSIC_MAIN_MODULES,
} = require("./classic-bundle.cjs");
const { classicOptimizerOptions } = require("./classic-optimizer.cjs");
const { CLASSIC_PLAYER_NAME_POLICY } = require("./classic-function-names.cjs");
const {
    applyPlayerBuildIdentity,
    createPlayerBuildIdentity,
} = require("./player-build-identity.cjs");

function tokenKind(token) {
    const label = token.type.label;
    if (label === "name") return "identifiers";
    if (label === "string") return "strings";
    if (label === "num") return "numbers";
    if (label === "regexp") return "regexp";
    return token.type.keyword ? "keywords" : "punctuation";
}

function tokensAndFunctions(source) {
    const tokens = [];
    const tree = parse(source, { ecmaVersion: 5, sourceType: "script" });
    const functions = [];
    function visit(node) {
        if (!node || typeof node !== "object") return;
        if (
            node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression"
        )
            functions.push(node.start);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") visit(value);
        }
    }
    visit(tree);
    let position = 0;
    for (const token of tokenizer(source, { ecmaVersion: 5 })) {
        if (position < token.start)
            tokens.push({ end: token.start, kind: "spacing", start: position });
        tokens.push({
            end: token.end,
            kind: tokenKind(token),
            start: token.start,
        });
        position = token.end;
    }
    if (position < source.length)
        tokens.push({ end: source.length, kind: "spacing", start: position });
    return { functions, tokens };
}

function measureSource(source) {
    const buffer = Buffer.from(source);
    const { functions, tokens } = tokensAndFunctions(source);
    const tokenBytes = {};
    for (const token of tokens)
        tokenBytes[token.kind] =
            (tokenBytes[token.kind] || 0) +
            Buffer.byteLength(source.slice(token.start, token.end));
    return {
        bytes: buffer.length,
        functions: functions.length,
        gzipBytes: gzipSync(buffer, { level: 9 }).length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        tokenBytes,
    };
}

function sourceSpans(code, map) {
    if (!map || !Array.isArray(map.mappings) || !Array.isArray(map.sources))
        throw new Error("Optimizer did not return a decoded source map");
    const spans = [];
    const lines = code.split("\n");
    let lineStart = 0;
    for (let line = 0; line < lines.length; line++) {
        const length = lines[line].length;
        const segments = map.mappings[line] || [];
        let start = 0;
        let owner = "<unmapped>";
        function append(end) {
            if (end > start)
                spans.push({
                    end: lineStart + end,
                    owner,
                    start: lineStart + start,
                });
            start = end;
        }
        for (const segment of segments) {
            assert(segment[0] >= start && segment[0] <= length);
            append(segment[0]);
            owner = segment.length > 1 ? map.sources[segment[1]] : "<unmapped>";
            assert.equal(typeof owner, "string");
        }
        append(length);
        if (line + 1 < lines.length)
            spans.push({
                end: lineStart + length + 1,
                owner: "<unmapped>",
                start: lineStart + length,
            });
        lineStart += length + 1;
    }
    return spans;
}

function attributeModules(code, map) {
    const spans = sourceSpans(code, map);
    const modules = new Map();
    function row(owner) {
        if (!modules.has(owner))
            modules.set(owner, {
                bytes: 0,
                functions: 0,
                module: owner,
                tokenBytes: {},
            });
        return modules.get(owner);
    }
    for (const span of spans)
        row(span.owner).bytes += Buffer.byteLength(
            code.slice(span.start, span.end)
        );
    const { functions, tokens } = tokensAndFunctions(code);
    let cursor = 0;
    for (const token of tokens) {
        while (cursor < spans.length && spans[cursor].end <= token.start)
            cursor++;
        for (let index = cursor; index < spans.length; index++) {
            const span = spans[index];
            if (span.start >= token.end) break;
            const bytes = Buffer.byteLength(
                code.slice(
                    Math.max(span.start, token.start),
                    Math.min(span.end, token.end)
                )
            );
            const target = row(span.owner).tokenBytes;
            target[token.kind] = (target[token.kind] || 0) + bytes;
        }
    }
    cursor = 0;
    for (const start of functions.sort((a, b) => a - b)) {
        while (cursor < spans.length && spans[cursor].end <= start) cursor++;
        row(spans[cursor]?.owner || "<unmapped>").functions++;
    }
    const result = Array.from(modules.values()).sort(
        (a, b) => b.bytes - a.bytes
    );
    assert.equal(
        result.reduce((sum, entry) => sum + entry.bytes, 0),
        Buffer.byteLength(code)
    );
    for (const entry of result)
        assert.equal(
            Object.values(entry.tokenBytes).reduce(
                (sum, bytes) => sum + bytes,
                0
            ),
            entry.bytes
        );
    assert.equal(
        result.reduce((sum, entry) => sum + entry.functions, 0),
        functions.length
    );
    return result;
}

async function optimizeComposition(linked, version, root, emitted) {
    const substitute = (code) => code.replace(/__OTTP_VERSION__/g, version);
    const source = substitute(
        linked.prelude + linked.parts.map((part) => part.code).join("\n")
    );
    const identity = createPlayerBuildIdentity(source, root);
    // Building can change tracked generated files after the clean revision was
    // embedded. Only current HEAD and the partial (empty) revision are valid;
    // the full compiled-source digest and every emitted byte must still match.
    const revisions = [identity.sourceRevision];
    const alternative = identity.sourceRevision ? "" : identity.sourceHead;
    if (alternative !== identity.sourceRevision) revisions.push(alternative);
    for (const sourceRevision of revisions) {
        const candidate = { ...identity, sourceRevision };
        const apply = (code) =>
            applyPlayerBuildIdentity(substitute(code), candidate);
        const input = { "<linker-prelude>": apply(linked.prelude) };
        for (const part of linked.parts) input[part.file] = apply(part.code);
        const optimized = await minify(input, {
            ...classicOptimizerOptions(
                applyPlayerBuildIdentity(source, candidate),
                CLASSIC_PLAYER_NAME_POLICY
            ),
            sourceMap: { asObject: true },
        });
        if (typeof optimized.code !== "string")
            throw new Error("Optimizer returned no player code");
        if (optimized.code === emitted) return optimized;
    }
    throw new Error(
        "Composition input does not match dist/player.js; run npm run build first"
    );
}

async function measureComposition(root, comparison) {
    const version =
        JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
            .version || "local";
    const linked = assembleClassic(root, CLASSIC_MAIN_MODULES, { parts: true });
    const emitted = fs.readFileSync(path.join(root, "dist/player.js"), "utf8");
    const optimized = await optimizeComposition(linked, version, root, emitted);
    const result = {
        artifact: "dist/player.js",
        attribution:
            "Generated UTF-8 bytes belong to the preceding source-map segment; folded expressions can span modules. Unmapped bytes are explicit.",
        modules: attributeModules(emitted, optimized.decoded_map),
        optimizerPolicy: "production",
        schema: 1,
        total: measureSource(emitted),
        version,
    };
    if (comparison) {
        const reference = fs.readFileSync(comparison, "utf8");
        const comparable = await minify(
            reference,
            // Arbitrary reference files have not had their callback-name
            // consumers audited. Keep the strict profile for those inputs.
            classicOptimizerOptions(reference)
        );
        result.comparison = {
            file: path.resolve(comparison),
            minified: measureSource(comparable.code),
            optimizerPolicy: "strict",
            original: measureSource(reference),
            scope: "Size-only minification with the strict default policy; this does not establish matching features or runtime contracts.",
        };
    }
    return result;
}

function argumentsFor(args) {
    const options = {
        comparison: undefined,
        output: "build/reports/classic-composition.json",
    };
    while (args.length) {
        const flag = args.shift();
        const value = args.shift();
        if (!value || !["--compare", "--output"].includes(flag))
            throw new Error(
                "Usage: node scripts/measure-classic-composition.cjs [--compare file.js] [--output report.json]"
            );
        options[flag === "--compare" ? "comparison" : "output"] = value;
    }
    return options;
}

async function main() {
    const root = path.resolve(__dirname, "..");
    const options = argumentsFor(process.argv.slice(2));
    const report = await measureComposition(root, options.comparison);
    const output = path.resolve(root, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(
        `Measured ${report.total.bytes} bytes, ${report.total.functions} functions: ${output}`
    );
}

module.exports = {
    argumentsFor,
    attributeModules,
    measureComposition,
    measureSource,
    optimizeComposition,
};
if (require.main === module)
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
