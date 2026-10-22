/** Load the actual private modules for extracted-source fixtures. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const files = [
    "screen-controller",
    "input-router",
    "classic-screen-port",
    "menu-registry",
];
module.exports = function screenRuntime(context) {
    const host = context.window || context;
    if (host.__ottClassicScreenPort) return;
    for (const file of files) {
        const filename = path.resolve(
            __dirname,
            "../../src/ui/" + file + ".ts"
        );
        const code =
            "(function(){" +
            ts.transpileModule(fs.readFileSync(filename, "utf8"), {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }).outputText +
            "\n})();";
        if (vm.isContext(context)) vm.runInContext(code, context, { filename });
        else host.eval(code);
    }
};
