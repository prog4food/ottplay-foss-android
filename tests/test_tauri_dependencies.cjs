const assert = require("node:assert/strict");
const {
    checkDependencies,
    readDependencies,
} = require("../scripts/check-tauri-dependencies.cjs");

const current = readDependencies();
checkDependencies(current);
let rejectedCases = 0;
function rejects(change, message) {
    const fixture = structuredClone(current);
    change(fixture);
    assert.throws(() => checkDependencies(fixture), message);
    rejectedCases += 1;
}

// Both direct updater updates and its transitive API updates can break the
// native protocol, even when npm installs successfully.
for (const name of ["@tauri-apps/plugin-updater", "@tauri-apps/api"]) {
    rejects((f) => {
        const location = Object.keys(f.npmLock.packages).find((key) =>
            key.endsWith(`node_modules/${name}`)
        );
        f.npmLock.packages[location].version = "2.99.0";
    }, /must match Rust/);
}
rejects((f) => {
    f.npmLock.packages["node_modules/nested/node_modules/@tauri-apps/api"] = {
        version: "2.99.0",
    };
}, /must match Rust/);
rejects((f) => {
    f.cargoLock = f.cargoLock.replace(
        /name = "tauri-plugin-updater"\nversion = "[^"]+"/,
        'name = "tauri-plugin-updater"\nversion = "2.99.0"'
    );
}, /must match Rust/);

for (const [name, version] of [
    ["wry", "0.55.1"],
    ["tao", "0.35.3"],
    ["glib", "0.18.5"],
    ["block", "0.1.6"],
]) {
    const entry = `name = "${name}"\nversion = "${version}"`;
    // Keeping the patch stanza must not mask a registry-resolved package.
    rejects((f) => {
        f.cargoLock = f.cargoLock.replace(
            entry,
            entry +
                '\nsource = "registry+https://github.com/rust-lang/crates.io-index"'
        );
    }, /must resolve locally/);
    // Cargo can leave a retired path patch under [[patch.unused]]. It is not
    // a selected package, even if its name/version still appears in the lock.
    rejects((f) => {
        f.cargoLock = f.cargoLock.replace(
            `[[package]]\n${entry}`,
            `[[patch.unused]]\n${entry}`
        );
    }, /must have one resolved package/);
    rejects((f) => {
        f.cargoLock += `\n[[package]]\nname = "${name}"\nversion = "99.0.0"\n`;
    }, /must have one resolved package/);
    rejects((f) => {
        f.workspace = f.workspace.replace(
            `path = "vendor/${name}-${version}"`,
            `path = "../unreviewed/${name}"`
        );
    }, /reviewed vendor directory/);
    const declaration = `${name} = { path = "vendor/${name}-${version}" }`;
    rejects((f) => {
        f.workspace = f.workspace.replace(
            declaration,
            `# ${declaration}\n${name} = { path = "../unreviewed/${name}" }`
        );
    }, /reviewed vendor directory/);
    rejects((f) => {
        f.workspace = f.workspace.replace(
            declaration,
            `${name} = { path = "../unreviewed/${name}" } # ${declaration}`
        );
    }, /reviewed vendor directory/);
    rejects((f) => {
        f.workspace = f.workspace.replace(
            declaration,
            `${declaration}\n${declaration}`
        );
    }, /duplicate patch/);
}

rejects((f) => {
    f.workspace = f.workspace.replace(
        "[patch.crates-io]",
        "# [patch.crates-io]"
    );
}, /one active patch.crates-io table/);
rejects((f) => {
    f.workspace +=
        '\n[patch.crates-io]\nwry = { path = "../unreviewed/wry" }\n';
}, /one active patch.crates-io table/);
rejects((f) => {
    f.workspace = f.workspace
        .replace(
            "[patch.crates-io]",
            '# [patch.crates-io]\n# wry = { path = "vendor/wry-0.55.1" }\n[patch.crates-io]'
        )
        .replace(
            'wry = { path = "vendor/wry-0.55.1" }\ntao',
            'wry = { path = "../unreviewed/wry" }\ntao'
        );
}, /reviewed vendor directory/);
rejects((f) => {
    f.workspace = f.workspace.replace(
        'wry = { path = "vendor/wry-0.55.1" }',
        'wry = { path = "vendor/wry-0.55.1", path = "../unreviewed/wry" }'
    );
}, /single-line path-only declarations/);
for (const quote of ['"""', "'''"]) {
    rejects((f) => {
        f.workspace = `[workspace.metadata]\nnotes = ${quote}\n${f.workspace}\n${quote}\n`;
    }, /does not support multiline TOML strings/);
}
const commented = structuredClone(current);
commented.workspace = commented.workspace
    .replace(
        "[patch.crates-io]",
        "# [patch.crates-io]\n  [patch.crates-io] # active patches"
    )
    .replace(
        'wry = { path = "vendor/wry-0.55.1" }',
        '  wry={path="vendor/wry-0.55.1"} # reviewed patch'
    );
checkDependencies(commented);
console.log(
    `PASS Tauri dependency guard: ${rejectedCases} rejected regressions`
);
