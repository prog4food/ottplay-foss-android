const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
module.exports = function offlineProfileSource(includeStore = true) {
    return (
        includeStore
            ? ["settings/store", "offline/profiles"]
            : ["offline/profiles"]
    )
        .map(
            (name) =>
                ts.transpileModule(
                    fs
                        .readFileSync(
                            path.join(__dirname, "../../src/" + name + ".ts"),
                            "utf8"
                        )
                        .replace(
                            /^import \{ commitSettingsWrites \} from .*;\n/m,
                            ""
                        )
                        .replace(/^export /gm, ""),
                    {
                        compilerOptions: {
                            module: ts.ModuleKind.None,
                            target: ts.ScriptTarget.ES5,
                        },
                    }
                ).outputText
        )
        .join("\n");
};
