"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "vendor/block-0.1.6");
const manifest = JSON.parse(
    fs.readFileSync(
        path.join(root, "vendor/block-0.1.6.provenance.json"),
        "utf8"
    )
);
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
function files(dir, prefix = "") {
    return fs.readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        const info = fs.lstatSync(full);
        assert.ok(
            info.isDirectory() || info.isFile(),
            "only regular crate files/directories are allowed"
        );
        return info.isDirectory()
            ? files(full, prefix + name + "/")
            : [prefix + name];
    });
}
assert.deepEqual(files(sourceRoot).sort(), Object.keys(manifest.files).sort());
assert.deepEqual(Object.keys(manifest.patchedFiles), ["src/lib.rs"]);
for (const [file, original] of Object.entries(manifest.files)) {
    assert.equal(
        hash(fs.readFileSync(path.join(sourceRoot, file))),
        manifest.patchedFiles[file] || original,
        file
    );
}
assert.equal(
    hash(
        fs.readFileSync(path.join(root, "vendor", manifest.licenseNotice.file))
    ),
    manifest.licenseNotice.sha256,
    "the exact upstream copyright and permission notice must remain intact"
);
const patched = fs.readFileSync(path.join(sourceRoot, "src/lib.rs"), "utf8");
const replacement =
    "// Backported from madsmtm/objc2 b6438c733a7a9bfe75e60b62126d1933137f42e4.\n" +
    "// Only the address is used by the Blocks ABI; this opaque type must be inhabited.\n" +
    "#[repr(C)]\nstruct Class {\n    _priv: [u8; 0],\n}";
const original = patched.replace(replacement, "enum Class { }");
assert.notEqual(original, patched);
assert.equal(
    hash(original),
    manifest.files["src/lib.rs"],
    "only the documented opaque-type backport may differ"
);
const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
assert.ok(
    cargo
        .split("[patch.crates-io]")[1]
        ?.split(/\n\[/)[0]
        .includes('block = { path = "vendor/block-0.1.6" }')
);
const records = fs
    .readFileSync(path.join(root, "Cargo.lock"), "utf8")
    .split("[[package]]")
    .filter((v) => /\nname = "block"\n/.test(v));
assert.equal(records.length, 1);
assert.match(records[0], /version = "0\.1\.6"/);
assert.doesNotMatch(records[0], /\n(?:source|checksum) =/);
assert.ok(
    process.argv.length === 2 ||
        (process.argv.length === 3 && process.argv[2] === "--runtime"),
    "usage: node scripts/check-block-backport.cjs [--runtime]"
);
console.log(
    "OK: block 0.1.6 exact published inventory, opaque-type backport, and workspace override"
);

if (process.argv[2] === "--runtime") {
    assert.equal(
        process.platform,
        "darwin",
        "runtime qualification requires Apple's actual Blocks runtime"
    );
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "block-backport-"));
    function run(command, args) {
        const result = spawnSync(command, args, {
            encoding: "utf8",
            timeout: 120000,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        assert.ifError(result.error);
        assert.equal(result.status, 0, command + " must succeed");
    }
    try {
        run("rustc", ["--version"]);
        const before = path.join(temporary, "before.rs");
        fs.writeFileSync(before, original);
        const negative = spawnSync(
            "rustc",
            [
                "--crate-name",
                "block",
                "--crate-type=lib",
                "--edition=2015",
                "--deny=uninhabited_static",
                "--emit=metadata",
                "-o",
                path.join(temporary, "before.rmeta"),
                before,
            ],
            { encoding: "utf8", timeout: 120000 }
        );
        assert.ifError(negative.error);
        assert.notEqual(
            negative.status,
            0,
            "original source must fail the soundness diagnostic"
        );
        assert.match(negative.stderr, /static of uninhabited type/);
        console.log(
            "OK: original source rejected by uninhabited_static calibration"
        );
        const library = path.join(temporary, "libblock.rlib");
        run("rustc", [
            "--crate-name",
            "block",
            "--crate-type=lib",
            "--edition=2015",
            "--deny=uninhabited_static",
            "-o",
            library,
            path.join(sourceRoot, "src/lib.rs"),
        ]);
        const object = path.join(temporary, "invoke.o");
        run("clang", [
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-c",
            path.join(root, "tests/block-ffi-invoke.c"),
            "-o",
            object,
        ]);
        const binary = path.join(temporary, "block-regression");
        run("rustc", [
            "--edition=2021",
            "--test",
            "--deny=warnings",
            path.join(root, "tests/block-ffi-regression.rs"),
            "--extern",
            "block=" + library,
            "-C",
            "link-arg=" + object,
            "-o",
            binary,
        ]);
        run(binary, ["--nocapture"]);
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
}
