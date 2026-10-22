"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const ts = require("typescript");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "vendor/hosted-epg");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
function artifacts() {
    const receipt = JSON.parse(
        fs.readFileSync(path.join(vendor, "manifest.json"), "utf8")
    );
    const files = {};
    for (const [name, digest] of Object.entries(receipt.files)) {
        const bytes = fs.readFileSync(path.join(vendor, name));
        assert.equal(
            sha(bytes),
            digest,
            "Modified hosted EPG dependency: " + name
        );
        if (name.endsWith(".js"))
            acorn.parse(bytes.toString(), { ecmaVersion: 5 });
        files[name] = bytes;
    }
    const source = fs.readFileSync(
        path.join(root, "src/hosted/epg-worker.ts"),
        "utf8"
    );
    const result = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            removeComments: true,
            target: ts.ScriptTarget.ES5,
        },
        reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error
    );
    assert.equal(errors.length, 0, "Hosted EPG worker compile failed");
    const worker =
        'importScripts("../js/runtime-polyfills.js", "../js/ottplay-core.js", "pako-inflate.js", "sax.js");\n' +
        result.outputText +
        "\ncreateHostedEpgWorker(self);\n";
    acorn.parse(worker, { ecmaVersion: 5 });
    files["epg-worker.js"] = Buffer.from(worker);
    const server = ts.transpileModule(
        fs.readFileSync(path.join(root, "src/hosted/epg-server.ts"), "utf8"),
        {
            compilerOptions: {
                removeComments: true,
                target: ts.ScriptTarget.ES5,
            },
            reportDiagnostics: true,
        }
    );
    assert.equal(
        (server.diagnostics || []).filter(
            (d) => d.category === ts.DiagnosticCategory.Error
        ).length,
        0,
        "Hosted EPG server transport compile failed"
    );
    const transport = server.outputText + "\ncreateHostedEpgServer(self);\n";
    acorn.parse(transport, { ecmaVersion: 5 });
    files["epg-server.js"] = Buffer.from(transport);
    const diagnostics = ts.transpileModule(
        fs.readFileSync(
            path.join(root, "src/hosted/epg-diagnostics.ts"),
            "utf8"
        ),
        {
            compilerOptions: {
                removeComments: true,
                target: ts.ScriptTarget.ES5,
            },
            reportDiagnostics: true,
        }
    );
    assert.equal(
        (diagnostics.diagnostics || []).filter(
            (d) => d.category === ts.DiagnosticCategory.Error
        ).length,
        0,
        "Hosted EPG diagnostics compile failed"
    );
    acorn.parse(diagnostics.outputText, { ecmaVersion: 5 });
    files["epg-diagnostics.js"] = Buffer.from(diagnostics.outputText);
    files["manifest.json"] = Buffer.from(
        JSON.stringify(receipt, null, 2) + "\n"
    );
    return files;
}
function stage(destination = root) {
    const directory = path.join(destination, "hosted");
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, bytes] of Object.entries(artifacts()))
        fs.writeFileSync(path.join(directory, name), bytes);
}
function checkStaged(destination) {
    for (const [name, bytes] of Object.entries(artifacts()))
        assert.equal(
            sha(fs.readFileSync(path.join(destination, "hosted", name))),
            sha(bytes),
            "Stale hosted EPG asset: " + name
        );
}
module.exports = { artifacts, checkStaged, stage };
if (require.main === module) {
    if (process.argv[2] === "--stage") stage(process.argv[3] || root);
    else artifacts();
    console.log(
        "PASS hosted EPG assets, licensed dependency receipts and ES5 syntax"
    );
}
