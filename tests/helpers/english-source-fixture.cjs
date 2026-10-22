// Source fixtures execute English declarations; classic/provider fixtures keep their stable ABI.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const file = path.join(__dirname, "../../src/compatibility/legacy-names.ts");
const source = fs.readFileSync(file, "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const compatibilitySource = ts
    .transpileModule(
        ast.statements
            .filter((node) => !ts.isIfStatement(node))
            .map((node) => node.getText(ast))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        }
    )
    .outputText.replace(/^export /gm, "");
const api = vm.createContext({});
vm.runInContext(compatibilitySource, api);
const legacyToCanonical = new Map(
    api.legacyPlayerBindings.map(([canonical, legacy]) => [legacy, canonical])
);
function classicName(name) {
    const prefix = name.startsWith("window.") ? "window." : "";
    const binding = prefix ? name.slice(prefix.length) : name;
    const pair = api.legacyPlayerBindings.find(
        ([canonical]) => canonical === binding
    );
    return prefix + (pair ? pair[1] : binding);
}
function sourceName(file, name) {
    if (!file.endsWith(".ts")) return name;
    const prefix = name.startsWith("window.") ? "window." : "";
    const binding = prefix ? name.slice(prefix.length) : name;
    return prefix + (legacyToCanonical.get(binding) || binding);
}
function sourceNames(file, names) {
    return names && names.map((name) => sourceName(file, name));
}
function attachSourceAliases(target) {
    if (typeof target.popupActionId !== "function") {
        if (vm.isContext(target)) vm.runInContext(compatibilitySource, target);
        else if (typeof target.eval === "function")
            target.eval(compatibilitySource);
        else
            throw new Error(
                "Source aliases need a VM or browser fixture context"
            );
    }
    const pairs = api.legacyPlayerBindings;
    const configurable = [];
    for (const [canonical, legacy] of pairs) {
        const descriptor = Object.getOwnPropertyDescriptor(target, canonical);
        if (descriptor && descriptor.configurable === false) {
            // Browser global function declarations cannot become accessors. Point
            // the provider-facing name at their writable binding instead.
            const old = Object.getOwnPropertyDescriptor(target, legacy);
            if (old && old.configurable === false)
                throw new Error(
                    "Both fixture bindings are fixed: " + canonical
                );
            Object.defineProperty(target, legacy, {
                configurable: true,
                enumerable: true,
                get() {
                    return target[canonical];
                },
                set(value) {
                    target[canonical] = value;
                },
            });
        } else {
            if (
                descriptor &&
                Object.hasOwn(descriptor, "value") &&
                descriptor.value !== undefined
            )
                target[legacy] = descriptor.value;
            configurable.push([canonical, legacy]);
        }
    }
    try {
        api.legacyPlayerBindings = configurable;
        api.installEnglishPlayerAliases(target);
    } finally {
        api.legacyPlayerBindings = pairs;
    }
}

module.exports = {
    attachSourceAliases,
    classicName,
    compatibilitySource,
    sourceName,
    sourceNames,
};
