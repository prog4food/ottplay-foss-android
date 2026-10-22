const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
function settingsSource() {
    return ts
        .transpileModule(
            ["../localization/assets", "store", "index", "editor"]
                .map((name) =>
                    fs.readFileSync(
                        path.join(root, "src/settings/" + name + ".ts"),
                        "utf8"
                    )
                )
                .join("\n"),
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^import .*$/gm, "")
        .replace(/^export /gm, "");
}
module.exports = { settingsSource };
