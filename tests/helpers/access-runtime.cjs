/** Load the real private authorization boundary for extracted ABI fixtures. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
module.exports = function accessRuntime(context) {
    const host = context.window || context;
    if (host.__ottParental) return;
    require("./pin-runtime.cjs")(context);
    for (const file of [
        "provider/source-identity",
        "access/session",
        "access/classic-adapter",
    ]) {
        const filename = path.resolve(__dirname, "../../src/" + file + ".ts");
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
