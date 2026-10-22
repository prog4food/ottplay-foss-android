const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const root = path.resolve(__dirname, "..");
const policy = JSON.parse(
    fs.readFileSync(path.join(root, "renovate.json"), "utf8")
);
const dependabot = YAML.parse(
    fs.readFileSync(path.join(root, ".github/dependabot.yml"), "utf8")
);
const updaterNames = ["@tauri-apps/plugin-updater", "tauri-plugin-updater"];

// Opting into two managers must retain the shared CI managers and avoid granting
// either updater bot ownership of the rest of the native dependency graph.
for (const manager of [
    "github-actions",
    "custom.regex",
    "custom.jsonata",
    "npm",
    "cargo",
]) {
    assert(
        policy.enabledManagers.includes(manager),
        `Missing ${manager} manager`
    );
}
assert(
    policy.extends.includes(
        "local>victron-venus/venus-os-ci-toolkit:renovate-ci"
    )
);
const baselineIndex = policy.packageRules.findIndex(
    (rule) =>
        rule.enabled === false &&
        ["npm", "cargo"].every((manager) =>
            rule.matchManagers?.includes(manager)
        )
);
assert(
    baselineIndex >= 0,
    "General application updates must retain their existing owner"
);
const groupIndex = policy.packageRules.findIndex(
    (rule) => rule.groupSlug === "tauri-updater"
);
assert(
    groupIndex > baselineIndex,
    "The narrow updater opt-in must follow the default deny rule"
);
const group = policy.packageRules[groupIndex];
assert.deepEqual([...group.matchPackageNames].sort(), [...updaterNames].sort());
assert.deepEqual([...group.matchFileNames].sort(), [
    "package.json",
    "src-tauri/Cargo.toml",
]);
assert.deepEqual([...group.matchManagers].sort(), ["cargo", "npm"]);
assert.equal(group.enabled, true);
assert.equal(
    group.minimumGroupSize,
    2,
    "Never propose a single ecosystem updater upgrade"
);
assert.equal(group.groupSingleUpdates, false);
assert.equal(group.separateMajorMinor, false);
assert.equal(group.separateMinorPatch, false);
assert.equal(
    group.rangeStrategy,
    "pin",
    "Both manifests must describe the resolved bindings"
);
assert.equal(
    group.allowedVersions,
    ">=2.12.0 <2.13.0",
    "Remove the hold only with the native WebView migration"
);
assert.equal(group.automerge, false);

const npm = dependabot.updates.find(
    (entry) => entry["package-ecosystem"] === "npm"
);
const ignore = npm.ignore.find(
    (entry) => entry["dependency-name"] === updaterNames[0]
);
assert(
    ignore && !ignore.versions && !ignore["update-types"],
    "Dependabot must not update one half of the pair"
);
assert.deepEqual(
    npm.ignore.find((entry) => entry["dependency-name"] === "@tauri-apps/api")
        ?.versions,
    [">=2.12.0"],
    "API minor upgrades require the native runtime/WebView migration"
);
assert.deepEqual(
    npm.ignore.find((entry) => entry["dependency-name"] === "ultracite")
        ?.versions,
    [">=7.10.3 <=8.0.1"],
    "Exclude only known vulnerable releases; review future fixes normally"
);
assert.deepEqual(
    npm.groups["npm-lockfile"].patterns,
    ["*"],
    "Other npm updates retain their lockfile group"
);
assert(
    !dependabot.updates.some((entry) => entry["package-ecosystem"] === "cargo"),
    "Do not introduce a competing native updater"
);
console.log(
    "Dependency updater ownership and cross-ecosystem grouping contracts passed"
);
