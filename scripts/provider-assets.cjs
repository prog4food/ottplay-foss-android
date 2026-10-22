const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// The registry and packaging share one declarative inventory. Retained source
// scripts are historical test oracles, never fallbacks for migrated drivers.
function managedProviderIds() {
    const filename = path.resolve(
        __dirname,
        "../src/provider/driver-profiles.ts"
    );
    const context = vm.createContext({ window: {} });
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
    vm.runInContext(code, context, { filename, timeout: 1000 });
    const profiles = context.window.__ottProviderDriverProfiles;
    if (!Array.isArray(profiles) || !profiles.length)
        throw new Error("Missing provider driver inventory");
    const ids = profiles.map((profile) => profile.id);
    if (
        new Set(ids).size !== ids.length ||
        ids.some(
            (id) =>
                typeof id !== "string" ||
                !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(id) ||
                id.split("/").some((part) => part === "..")
        )
    )
        throw new Error("Invalid provider driver inventory");
    return Array.from(ids);
}
const ids = new Set(managedProviderIds());
function isManagedProviderScript(filename) {
    const normalized = filename.replace(/\\/g, "/");
    const match = /(?:^|\/)providers\/(.+)\/provider\.js$/.exec(normalized);
    return !!match && ids.has(match[1]);
}
module.exports = { isManagedProviderScript, managedProviderIds };
