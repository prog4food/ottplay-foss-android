const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Keep only the latest compiled code per input file, never a fixture's state.
const scripts = new Map();

// Run the actual private implementation in the same realm as each host fixture.
module.exports = function privateRuntime(context, relativeFile) {
    const filename = path.resolve(__dirname, "../..", relativeFile);
    const source = fs.readFileSync(filename, "utf8");
    let cached = scripts.get(filename);
    if (!cached || cached.source !== source) {
        const compiled = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText;
        const script = new vm.Script(
            "(function () {\n" + compiled + "\n}).call(this);",
            { filename }
        );
        cached = { script, source };
        scripts.set(filename, cached);
    }
    cached.script.runInContext(context);
};
