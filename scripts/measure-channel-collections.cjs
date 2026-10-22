#!/usr/bin/env node
// Compare two source trees without copying a historical implementation into this repo.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const acorn = require("acorn");
const ts = require("typescript");

const options = { samples: 5, sourceRoot: path.resolve(__dirname, "..") };
for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    const flags = {
        "--base-root": "baseRoot",
        "--out": "out",
        "--samples": "samples",
        "--source-root": "sourceRoot",
    };
    const key = Object.hasOwn(flags, flag) ? flags[flag] : null;
    if (!key || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) {
        console.error(
            "Usage: node scripts/measure-channel-collections.cjs --base-root DIR [--source-root DIR] [--samples 5] [--out FILE]"
        );
        process.exit(2);
    }
    options[key] = process.argv[++i];
}
options.samples = Number(options.samples);
if (
    !options.baseRoot ||
    !Number.isInteger(options.samples) ||
    options.samples < 1 ||
    options.samples > 25
) {
    console.error("Provide --base-root and 1..25 samples.");
    process.exit(2);
}
options.baseRoot = path.resolve(options.baseRoot);
options.sourceRoot = path.resolve(options.sourceRoot);
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const files = ["src/channels/library.ts", "src/channels/favorites-lists.ts"];
const helperNames = [
    "favoriteReferenceKey",
    "appendFavoriteReferences",
    "mergeFavoriteReferences",
    "favoriteReferenceRecord",
];
function load(root) {
    const hashes = {};
    const code = files
        .map((file) => {
            const source = fs.readFileSync(path.join(root, file), "utf8");
            hashes[file] = digest(source);
            let selected = source;
            if (file.endsWith("favorites-lists.ts")) {
                const tree = ts.createSourceFile(
                    file,
                    source,
                    ts.ScriptTarget.Latest,
                    true
                );
                const functions = tree.statements.filter(
                    (node) =>
                        ts.isFunctionDeclaration(node) &&
                        helperNames.includes(node.name?.text)
                );
                for (const required of helperNames.filter(
                    (name) => name !== "appendFavoriteReferences"
                ))
                    assert(
                        functions.some((node) => node.name.text === required),
                        "Missing actual function " + required
                    );
                selected = functions
                    .map((node) => node.getText(tree))
                    .join("\n");
            }
            const compiled = ts.transpileModule(selected, {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    removeComments: true,
                    target: ts.ScriptTarget.ES5,
                },
                reportDiagnostics: true,
            });
            assert.equal(
                (compiled.diagnostics || []).filter(
                    (entry) => entry.category === ts.DiagnosticCategory.Error
                ).length,
                0
            );
            acorn.parse(compiled.outputText, { ecmaVersion: 5 });
            return compiled.outputText;
        })
        .join("\n");
    return { code, emittedSha256: digest(code), hashes };
}
const base = load(options.baseRoot),
    candidate = load(options.sourceRoot);
function run(context, code) {
    return vm.runInContext(code, context, { timeout: 15000 });
}
function context(source, setup) {
    const value = vm.createContext({});
    value.window = value;
    run(value, source.code + "\n" + setup);
    return value;
}
function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
function compare(name, size, setup, checksum, instrument) {
    const contexts = [context(base, setup), context(candidate, setup)];
    const times = [[], []];
    contexts.forEach((value) => run(value, "sample(); sample();"));
    for (let i = 0; i < options.samples; i++) {
        for (const index of i % 2 ? [1, 0] : [0, 1]) {
            const start = performance.now();
            run(contexts[index], "sample();");
            times[index].push(performance.now() - start);
        }
    }
    const output = contexts.map((value) => run(value, checksum));
    assert.equal(output[0], output[1], name + " output mismatch at " + size);
    const cost = contexts.map((value) => run(value, instrument));
    return {
        base: {
            medianMs: median(times[0]),
            operations: JSON.parse(cost[0]),
            samplesMs: times[0],
        },
        candidate: {
            medianMs: median(times[1]),
            operations: JSON.parse(cost[1]),
            samplesMs: times[1],
        },
        name,
        outputSha256: digest(output[0]),
        size,
        speedup: median(times[0]) / median(times[1]),
    };
}
const results = [];
const indexCost = `var comparisons=0,calls=0,original=Array.prototype.indexOf;
Array.prototype.indexOf=function(){var at=original.apply(this,arguments);calls++;comparisons+=at<0?this.length:at+1;return at;};
try { sample(); } finally { Array.prototype.indexOf=original; }
JSON.stringify({indexOfCalls:calls,indexComparisons:comparisons});`;
for (const mode of ["stored-locks", "legacy-locks", "stored-no-unlocks"])
    for (const size of [1000, 4000, 16000]) {
        const legacy = mode === "legacy-locks";
        const setup = `var rows=[],locks=[],unlocks=[];for(var i=0;i<${size};i++){
rows.push({groupId:'g'+i%20,groupLabel:'Group'+i%20,id:i+1,itemId:'item:'+i,label:'Channel'+i,locked:${legacy}});
locks.push('item:'+i);if(${mode !== "stored-no-unlocks"} && !(i%2))unlocks.push('item:'+i);}
var stored=JSON.stringify({version:1,sourceId:'fixture',groups:[],hidden:[],locks:locks,unlocks:unlocks,preferences:{},nextGroup:1,selected:null});
var prior=JSON.stringify(rows.filter(function(_,i){return !(i%2);}).map(function(row){return row.id;}));
var ports={current:function(){return true;},sourceId:'fixture',get:function(key){return ${legacy ? "key==='parentalArray'?prior:null" : "key==='channelLibrary:fixture'?stored:null"};},set:function(){throw Error('unexpected write');}};
var result;function sample(){result=window.__ottChannelLibrary.create(ports,rows);}`;
        results.push(
            compare(
                mode,
                size,
                setup,
                "JSON.stringify({snapshot:result.snapshot(),document:result.document()});",
                indexCost
            )
        );
    }
const concatCost = `var calls=0,slots=0,comparisons=0,original=Array.prototype.concat,originalIndexOf=Array.prototype.indexOf;
Array.prototype.concat=function(){calls++;slots+=this.length;for(var i=0;i<arguments.length;i++)slots+=Array.isArray(arguments[i])?arguments[i].length:1;return original.apply(this,arguments);};
Array.prototype.indexOf=function(){var at=originalIndexOf.apply(this,arguments);comparisons+=at<0?this.length:at+1;return at;};
try { sample(); } finally { Array.prototype.concat=original; Array.prototype.indexOf=originalIndexOf; }
JSON.stringify({concatCalls:calls,concatCopiedSlots:slots,indexComparisons:comparisons});`;
for (const invisible of [true, false])
    for (const record of [false, true])
        for (const size of [1000, 2000, 4000]) {
            const setup = `var view=[],references=[],bindings=Object.create(null);for(var i=0;i<${size};i++){
var ref={itemId:'item:'+i};if(${invisible})references.push({legacyId:i+100000,origin:'raw',ambiguous:true});references.push(ref);bindings[i]=ref;view.push(i);}
var prior={view:view,references:references,bindings:bindings};var index={project:function(ref){return ref.itemId===undefined?null:Number(ref.itemId.slice(5));},resolve:function(id){return {itemId:'item:'+id};}};
var result,record;function sample(){result=mergeFavoriteReferences(view,prior,index);${record ? "record=favoriteReferenceRecord(view,result,index,prior,true);" : ""}}`;
            results.push(
                compare(
                    (record ? "favorite-merge-and-record" : "favorite-merge") +
                        (invisible ? "" : "-all-visible"),
                    size,
                    setup,
                    `if(result.length!==references.length)throw Error('length');for(var i=0;i<result.length;i++)if(result[i]!==references[i])throw Error('identity');${record ? "for(var i=0;i<view.length;i++)if(record.bindings[view[i]]!==bindings[view[i]])throw Error('binding identity');" : ""}JSON.stringify({references:result,bindings:${record ? "record.bindings" : "null"}});`,
                    concatCost
                )
            );
        }
const report = {
    base: { emittedSha256: base.emittedSha256, hashes: base.hashes },
    candidate: {
        emittedSha256: candidate.emittedSha256,
        hashes: candidate.hashes,
    },
    method: "Actual functions compiled to ES5; alternating warmed single-call samples; checksum and identity checked outside timing; operation counts measured separately. Synthetic microbenchmark, not whole-player performance.",
    node: process.version,
    options,
    results,
    typescript: ts.version,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (options.out) fs.writeFileSync(options.out, text);
process.stdout.write(text);
