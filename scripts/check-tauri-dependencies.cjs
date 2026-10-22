const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Cargo's lockfile records the selected source, while [patch.crates-io] alone
// can silently become unused after a dependency moves to a new minor release.
function lockedCrate(lock, name) {
    const records = lock
        .split(/^\[\[package\]\][ \t]*$/m)
        .slice(1)
        .map((record) => record.split(/^\[/m)[0])
        .filter((record) => record.includes(`\nname = "${name}"\n`));
    assert.equal(records.length, 1, `${name} must have one resolved package`);
    const version = records[0].match(/^version = "([^"]+)"$/m)?.[1];
    assert.ok(version, `${name} must have a locked version`);
    return { record: records[0], version };
}

function patchDirectories(workspace) {
    const lines = workspace
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    // A multiline string could contain text that resembles an active table.
    // This narrow guard fails closed instead of implementing general TOML.
    assert.ok(
        lines.every((line) => !/"""|'''/.test(line)),
        "native workspace guard does not support multiline TOML strings"
    );
    const headers = lines.flatMap((line, index) =>
        /^\[patch\.crates-io\]\s*(?:#.*)?$/.test(line) ? [index] : []
    );
    assert.equal(
        headers.length,
        1,
        "one active patch.crates-io table is required"
    );
    const directories = new Map();
    for (const line of lines.slice(headers[0] + 1)) {
        if (line.startsWith("[")) break;
        // Deliberately require the reviewed single-line path-only format.
        // Comments must never stand in for an active Cargo declaration.
        const entry = line.match(
            /^([\w-]+)\s*=\s*\{\s*path\s*=\s*"([^"\\]+)"\s*\}\s*(?:#.*)?$/
        );
        assert.ok(entry, "patches must use single-line path-only declarations");
        assert.ok(
            !directories.has(entry[1]),
            `duplicate patch for ${entry[1]}`
        );
        directories.set(entry[1], entry[2]);
    }
    return directories;
}

function checkDependencies({ manifest, npmLock, cargoLock, workspace }) {
    for (const [npmName, rustName] of [
        ["@tauri-apps/api", "tauri"],
        ["@tauri-apps/plugin-updater", "tauri-plugin-updater"],
    ]) {
        const rust = lockedCrate(cargoLock, rustName);
        const npmPackages = Object.entries(npmLock.packages).filter(
            ([name]) =>
                name === `node_modules/${npmName}` ||
                name.endsWith(`/node_modules/${npmName}`)
        );
        assert.ok(npmPackages.length, `${npmName} must be locked`);
        for (const [location, npm] of npmPackages) {
            assert.equal(
                npm.version.split(".").slice(0, 2).join("."),
                rust.version.split(".").slice(0, 2).join("."),
                `${location} ${npm.version} must match Rust ${rustName} ${rust.version} major/minor`
            );
        }
    }
    const updater = "@tauri-apps/plugin-updater";
    const version = npmLock.packages[`node_modules/${updater}`]?.version;
    assert.equal(manifest.dependencies[updater], version);
    assert.equal(npmLock.packages[""].dependencies[updater], version);

    const patches = patchDirectories(workspace);
    for (const [name, expected] of [
        ["wry", "0.55.1"],
        ["tao", "0.35.3"],
        ["glib", "0.18.5"],
        ["block", "0.1.6"],
    ]) {
        const resolved = lockedCrate(cargoLock, name);
        assert.equal(
            resolved.version,
            expected,
            `${name} must resolve to the reviewed native backport`
        );
        assert.doesNotMatch(
            resolved.record,
            /^(?:source|checksum)\s*=/m,
            `${name} must resolve locally, not from a registry or Git`
        );
        assert.equal(
            patches.get(name),
            `vendor/${name}-${expected}`,
            `${name} must resolve through its reviewed vendor directory`
        );
    }
}

function readDependencies(root = path.resolve(__dirname, "..")) {
    const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
    return {
        cargoLock: read("Cargo.lock"),
        manifest: JSON.parse(read("package.json")),
        npmLock: JSON.parse(read("package-lock.json")),
        workspace: read("Cargo.toml"),
    };
}

if (require.main === module) {
    checkDependencies(readDependencies());
    console.log("PASS Tauri npm/Rust versions and resolved native backports");
}

module.exports = { checkDependencies, readDependencies };
