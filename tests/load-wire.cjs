/* Load the shipped generated policy in the same ES5 VM used by host tests. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
module.exports = function loadWire() {
    const source = fs.readFileSync(
        path.join(__dirname, "../src/shared/wire-contracts.ts"),
        "utf8"
    );
    const code = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    const context = { exports: {} };
    vm.runInNewContext(code, context);
    return context.exports;
};
