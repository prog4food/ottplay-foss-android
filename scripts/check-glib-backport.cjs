const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(
    fs.readFileSync(
        path.join(root, "vendor/glib-0.18.5.provenance.json"),
        "utf8"
    )
);
const sourceRoot = path.join(root, "vendor/glib-0.18.5");
function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}
function files(dir, prefix = "") {
    return fs.readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name),
            relative = prefix + name;
        const info = fs.lstatSync(full);
        assert.ok(
            !info.isSymbolicLink(),
            "vendored source must not contain symlinks"
        );
        return info.isDirectory() ? files(full, relative + "/") : [relative];
    });
}
assert.deepEqual(
    files(sourceRoot).sort(),
    Object.keys(manifest.files).sort(),
    "published crate file inventory must remain intact"
);
assert.deepEqual(
    Object.keys(manifest.patchedFiles),
    ["src/variant_iter.rs"],
    "only the upstream unsafe iterator fix is applied"
);
for (const [file, originalHash] of Object.entries(manifest.files)) {
    const data = fs.readFileSync(path.join(sourceRoot, file));
    assert.equal(
        sha256(data),
        manifest.patchedFiles[file] || originalHash,
        file + " must match the published crate or documented patch"
    );
}
const patched = fs.readFileSync(
    path.join(sourceRoot, "src/variant_iter.rs"),
    "utf8"
);
const unpatched = patched
    .replace(
        "let mut p: *mut libc::c_char = std::ptr::null_mut();",
        "let p: *mut libc::c_char = std::ptr::null_mut();"
    )
    .replace("                &mut p,\n", "                &p,\n");
assert.notEqual(unpatched, patched);
assert.equal(
    sha256(unpatched),
    manifest.files["src/variant_iter.rs"],
    "the source diff must be exactly the upstream two-line fix"
);
for (const [directory, source] of [
    [".", "vendor/glib-0.18.5"],
    ["tests/macos-drag-regression", "../../vendor/glib-0.18.5"],
]) {
    const cargo = fs.readFileSync(
        path.join(root, directory, "Cargo.toml"),
        "utf8"
    );
    const overrides = cargo.split("[patch.crates-io]")[1]?.split(/\n\[/)[0];
    assert.ok(
        overrides?.includes(`glib = { path = "${source}" }`),
        directory + " must apply the GLib security backport"
    );
    const lock = fs.readFileSync(
        path.join(root, directory, "Cargo.lock"),
        "utf8"
    );
    const records = lock
        .split("[[package]]")
        .filter((entry) => /\nname = "glib"\n/.test(entry));
    assert.equal(
        records.length,
        1,
        directory + " must resolve one GLib version"
    );
    assert.match(records[0], /version = "0\.18\.5"/);
    assert.doesNotMatch(
        records[0],
        /\n(?:source|checksum) =/,
        directory +
            " must resolve GLib locally, not to the unpatched registry release"
    );
}
console.log(
    "OK: glib 0.18.5 published source inventory, exact upstream safety patch, and workspace overrides"
);
