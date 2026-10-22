/** Actual shipped PIN crypto in the fixture's realm; Node supplies host CSPRNG. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");
module.exports = function pinRuntime(context) {
    const host = context.window || context;
    if (host.__ottPinSecurity) return;
    if (!host.crypto) host.crypto = crypto.webcrypto;
    if (!host.setTimeout) host.setTimeout = setTimeout;
    for (const file of [
        "js/vendor/sjcl-pin.js",
        "src/access/pin-security.ts",
    ]) {
        let code = fs.readFileSync(
            path.resolve(__dirname, "../..", file),
            "utf8"
        );
        if (file.endsWith(".ts"))
            code = ts.transpileModule(code, {
                compilerOptions: { target: ts.ScriptTarget.ES5 },
            }).outputText;
        if (vm.isContext(context))
            vm.runInContext("(function(){" + code + "})();", context);
        else host.eval("(function(){" + code + "})();");
    }
};
