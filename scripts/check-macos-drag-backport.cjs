const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const crates = [
    {
        archiveSha256:
            "186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514",
        name: "wry",
        source: "src/wkwebview/drag_drop.rs",
        version: "0.55.1",
    },
    {
        archiveSha256:
            "d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9",
        name: "tao",
        source: "src/platform_impl/macos/window_delegate.rs",
        version: "0.35.3",
    },
];
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function files(directory, prefix = "") {
    return fs.readdirSync(directory).flatMap((name) => {
        const full = path.join(directory, name);
        const entry = fs.lstatSync(full);
        assert.ok(
            !entry.isSymbolicLink(),
            "vendored source cannot use symlinks"
        );
        return entry.isDirectory()
            ? files(full, prefix + name + "/")
            : [prefix + name];
    });
}

// Reverse the documented single-file diff in memory. This verifies the exact
// change without writing to the checkout or requiring platform-specific tools.
function originalSource(patched, patch, source) {
    const input = patched.split("\n");
    const diff = patch.trimEnd().split("\n");
    assert.equal(diff.shift(), "--- a/" + source);
    assert.equal(diff.shift(), "+++ b/" + source);
    let cursor = 0;
    const output = [];
    let hunkCount = 0;
    for (let index = 0; index < diff.length; ) {
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(
            diff[index++]
        );
        assert.ok(hunk, "patch must contain only ordinary unified hunks");
        const next = Number(hunk[3]) - 1;
        assert.ok(next >= cursor, "patch hunks must not overlap");
        output.push(...input.slice(cursor, next));
        cursor = next;
        assert.equal(output.length, Number(hunk[1]) - 1);
        let oldCount = 0;
        let newCount = 0;
        while (index < diff.length && !diff[index].startsWith("@@ ")) {
            const line = diff[index++];
            const kind = line[0];
            assert.ok(" +-".includes(kind), "unexpected patch directive");
            if (kind !== "-") {
                assert.equal(input[cursor++], line.slice(1));
                newCount++;
            }
            if (kind !== "+") {
                output.push(line.slice(1));
                oldCount++;
            }
        }
        assert.equal(oldCount, Number(hunk[2] ?? 1));
        assert.equal(newCount, Number(hunk[4] ?? 1));
        hunkCount++;
    }
    assert.ok(hunkCount > 0, "a safety patch must be present");
    return output.concat(input.slice(cursor)).join("\n");
}

const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
const lock = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
const overrides = cargo.split("[patch.crates-io]")[1]?.split(/\n\[/)[0];
assert.ok(overrides, "workspace patches must be configured");

for (const crate of crates) {
    const directory = crate.name + "-" + crate.version;
    const sourceRoot = path.join(root, "vendor", directory);
    const manifest = JSON.parse(
        fs.readFileSync(sourceRoot + ".provenance.json", "utf8")
    );
    assert.equal(manifest.crate, crate.name);
    assert.equal(manifest.version, crate.version);
    assert.equal(manifest.archiveSha256, crate.archiveSha256);
    assert.equal(
        manifest.archive,
        `https://static.crates.io/crates/${crate.name}/${directory}.crate`
    );
    assert.deepEqual(
        files(sourceRoot).sort(),
        Object.keys(manifest.files).sort()
    );
    assert.deepEqual(Object.keys(manifest.patchedFiles), [crate.source]);
    for (const [file, originalHash] of Object.entries(manifest.files)) {
        assert.equal(
            sha256(fs.readFileSync(path.join(sourceRoot, file))),
            manifest.patchedFiles[file] || originalHash,
            directory + "/" + file + " must match its published or patched hash"
        );
    }
    assert.equal(manifest.patch, directory + "-macos-drag-pasteboard.patch");
    const patch = fs.readFileSync(
        path.join(root, "vendor", manifest.patch),
        "utf8"
    );
    assert.equal(sha256(patch), manifest.patchSha256);
    const patched = fs.readFileSync(
        path.join(sourceRoot, crate.source),
        "utf8"
    );
    assert.equal(
        sha256(originalSource(patched, patch, crate.source)),
        manifest.files[crate.source],
        "reversing the exact patch must recover the published source"
    );
    assert.ok(
        overrides.includes(`${crate.name} = { path = "vendor/${directory}" }`),
        crate.name + " must use its local patched dependency"
    );
    const records = lock
        .split("[[package]]")
        .filter((record) => record.includes(`\nname = "${crate.name}"\n`));
    assert.equal(
        records.length,
        1,
        crate.name + " must have one locked version"
    );
    assert.ok(records[0].includes(`\nversion = "${crate.version}"\n`));
    assert.doesNotMatch(records[0], /\n(?:source|checksum) =/);
    console.log(
        `OK: ${directory} published inventory, exact safety patch, local override`
    );
}
