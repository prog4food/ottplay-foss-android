const {
    attachSourceAliases,
    classicName,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
/* Use one classic-script scope, as the shipped concatenated bundle does. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.join(__dirname, "..");
const methods = ["GetItem", "HasItem", "HasItemValue", "SetItem", "DelItem"];
const aliasNames = methods.map((method) => "_provider" + method);
const policyNames = [
    "providerDistribution",
    "isPlayDistribution",
    "isProviderAllowed",
];
const visibilityNames = [
    "toggleProviderSelectionVisibility",
    "toggleProviderSettingsVisibility",
    "providerSelectionUnlockCount",
    "providerSettingsUnlockCount",
];
const bundle = process.argv.includes("--bundle");
const runtimeName = bundle ? classicName : (name) => name;

function declarations(file, names) {
    names = sourceNames(file, names);
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const selected = [];
    const found = [];
    for (const node of ast.statements) {
        if (ts.isFunctionDeclaration(node) && node.body) {
            const name = node.name.text;
            if (!names || names.includes(name)) {
                selected.push(node.getText(ast).replace(/^export\s+/, ""));
                found.push(name);
            }
        } else if (ts.isVariableStatement(node)) {
            for (const entry of node.declarationList.declarations) {
                const name = entry.name.getText(ast);
                if (entry.initializer && (!names || names.includes(name))) {
                    selected.push("var " + entry.getText(ast) + ";");
                    found.push(name);
                }
            }
        }
    }
    if (names) {
        for (const name of names)
            assert(found.includes(name), file + ": " + name);
    }
    return { code: selected.join("\n"), names: found };
}

const lz = declarations("src/utils/lzstring.ts");
const storage = declarations("src/storage/index.ts");
const code = bundle
    ? declarations("dist/player.js", [
          ...lz.names,
          ...storage.names,
          "__spreadArray",
          "loadProv",
          "pdsa",
          ...policyNames,
          ...visibilityNames.map(runtimeName),
          ...aliasNames,
      ]).code
    : [
          lz.code,
          storage.code,
          declarations("src/provider/index.ts", [
              "loadProv",
              "pdsa",
              ...policyNames,
              ...visibilityNames,
          ]).code,
          declarations("src/index.ts", aliasNames).code,
      ].join("\n");

const saved = new Map();
let firstRuns = 0;
const context = {
    _: (text) => text,
    $() {
        return {
            append() {
                return this;
            },
            hide() {
                return this;
            },
            is: () => true,
        };
    },
    arrayProvaiders: [],
    cancelMediaLoad() {},
    cancelPortChannelIdMigration() {},
    console,
    document: { getElementById: () => null },
    firstRun() {
        firstRuns++;
    },
    invalidateEpgCache() {},
    launch_id: "#launch",
    localStorage: {
        getItem: (key) => (saved.has(key) ? saved.get(key) : null),
        removeItem: (key) => saved.delete(key),
        setItem: (key, value) => saved.set(key, String(value)),
    },
    location: { search: "" },
    popupActions: [],
    popupArray: [],
    popupDetail: [],
    restoreDemoMute() {},
    savedPopup: {
        popupActions: [() => {}],
        popupArray: ["Menu"],
        popupDetail: [""],
        ver: "fixture",
    },
};
context.window = context;
vm.createContext(context);
require("./helpers/access-runtime.cjs")(context);
require("./helpers/private-runtime.cjs")(context, "src/provider/runtime.ts");
require("./helpers/private-runtime.cjs")(
    context,
    "src/provider/driver-profiles.ts"
);
require("./helpers/private-runtime.cjs")(
    context,
    "src/provider/stalker-driver.ts"
);
require("./helpers/private-runtime.cjs")(
    context,
    "src/provider/catalog-drivers.ts"
);
for (const module of [
    "catalog-xml",
    "media-catalog",
    "playlist-drivers",
    "edem-driver",
    "m3u-settings",
    "m3u-driver",
])
    require("./helpers/private-runtime.cjs")(
        context,
        "src/provider/" + module + ".ts"
    );
require("./helpers/private-runtime.cjs")(context, "src/provider/drivers.ts");
vm.runInContext(
    ts.transpileModule(code, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText,
    context
);
if (!bundle) attachSourceAliases(context);

// First-run reset and repeated reloads must restore originals after provider overrides.
for (let round = 0; round < 3; round++) {
    if (round) {
        for (const method of methods) {
            context["provider" + method] = () => {
                throw new Error(
                    "Previous provider implementation must be discarded"
                );
            };
        }
    }
    context.loadProv();
    assert.equal(firstRuns, round + 1);
    context.setProviderPrefix("provider-" + round + ":");
    assert.equal(context.providerHasItem("missing"), false);
    assert.equal(context.providerGetItem("missing"), null);
    context.providerSetItem("empty", "");
    assert.equal(context.providerHasItem("empty"), true);
    assert.equal(context.providerHasItemValue("empty"), false);
    const value = "EPG history Кириллица ".repeat(50);
    context.providerSetItem("history", value);
    assert.equal(context.providerGetItem("history"), value);
    const decompress = context.decompress;
    let decompressions = 0;
    context.decompress = (compressed) => {
        decompressions++;
        return decompress(compressed);
    };
    assert.equal(context.providerHasItemValue("history"), true);
    context.decompress = decompress;
    assert.equal(
        decompressions,
        1,
        "Presence checks decode stored data only once"
    );
    assert(
        saved.get("provider-" + round + ":history").startsWith("\x01LZ\x01")
    );
    context.providerDelItem("history");
    assert.equal(context.providerHasItem("history"), false);
    assert.equal(context.providerHasItemValue("history"), false);
}
console.log(
    "PASS provider storage reset: first run + 2 reloads, all 5 helpers"
);

assert(
    context.pdsa.includes("playbackJournal"),
    "source reset clears typed journal"
);
assert(
    context.pdsa.includes("continueWatch"),
    "source reset clears legacy resume mirror"
);

for (const [method, key, policy] of [
    ["toggleProviderSelectionVisibility", "noSelProv", "providers"],
    ["toggleProviderSettingsVisibility", "noProvParam", "settings"],
]) {
    for (const stored of ["0", "1"]) {
        let value = stored,
            granted = false,
            resume,
            confirmed,
            restarts = 0,
            prompts = 0;
        context.__ottParental = {
            needs(kind) {
                assert.equal(kind, policy);
                return !granted;
            },
        };
        context.stbGetItem = (name) => {
            assert.equal(name, key);
            return value;
        };
        context.stbSetItem = (name, next) => {
            assert.equal(name, key);
            value = next;
        };
        context.enterPinAndSetAccess = (callback) => (resume = callback);
        context.confirmBox = (message, yes) => {
            prompts++;
            assert.equal(
                message.startsWith(stored === "1" ? "Show" : "Hide"),
                true
            );
            confirmed = yes;
        };
        context.restart = () => restarts++;
        context[runtimeName("providerSelectionUnlockCount")] = 0;
        context[runtimeName("providerSettingsUnlockCount")] = 0;
        for (let i = 0; i < 6; i++) context[runtimeName(method)]();
        assert.equal(resume, undefined, "Six presses do not open the PIN gate");
        assert.equal(prompts, 0);
        context[runtimeName(method)]();
        assert.equal(typeof resume, "function");
        assert.equal(
            prompts,
            0,
            "PIN confirmation precedes the setting confirmation"
        );
        granted = true;
        resume();
        assert.equal(prompts, 1);
        assert.equal(
            value,
            stored,
            "Cancelling confirmation keeps the existing bit"
        );
        assert.equal(restarts, 0);
        confirmed = undefined;
        for (let i = 0; i < 6; i++) context[runtimeName(method)]();
        assert.equal(
            confirmed,
            undefined,
            "Cancellation resets the seven-press gate"
        );
        context[runtimeName(method)]();
        confirmed();
        assert.equal(value, stored === "1" ? "0" : "1");
        assert.equal(restarts, 1);
    }
}
console.log(
    "PASS provider visibility: both flags/states, PIN, seven presses and cancelled confirmation"
);
