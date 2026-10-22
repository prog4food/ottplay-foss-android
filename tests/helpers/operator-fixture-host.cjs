"use strict";
const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm"),
    ts = require("typescript");
const source = fs.readFileSync(
    path.resolve(__dirname, "../../src/provider/operator.ts"),
    "utf8"
);
const aliases = fs
    .readFileSync(
        path.resolve(__dirname, "../../src/compatibility/legacy-names.ts"),
        "utf8"
    )
    .replace(/^export /gm, "")
    .replace(
        'if (typeof window !== "undefined") installEnglishPlayerAliases(window as any);',
        ""
    );
const code = ts.transpileModule(
    aliases +
        "\nlegacyPlayerBindings.forEach(function (pair) { if (typeof window[pair[1]] === 'undefined' && typeof window[pair[0]] !== 'undefined') window[pair[1]] = window[pair[0]]; });\ninstallEnglishPlayerAliases(window);\n" +
        source,
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
module.exports = function (context) {
    vm.runInContext(code, context);
};
