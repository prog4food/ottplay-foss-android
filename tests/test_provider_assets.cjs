const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    isManagedProviderScript,
    managedProviderIds,
} = require("../scripts/provider-assets.cjs");
const { stagePlayProviders } = require("../scripts/android-distribution.cjs");
const { isRetiredRuntimeScript } = require("../scripts/runtime-assets.cjs");
const root = path.resolve(__dirname, "..");
const ids = managedProviderIds();
assert.equal(ids.length, 51);
for (const id of ["antifriz", "edem", "kb-team", "m3u", "plex"])
    assert(ids.includes(id), "new independent driver asset boundary: " + id);
function compatibilityProviders(directory, prefix = "") {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const name = prefix ? prefix + "/" + entry.name : entry.name;
            if (entry.isDirectory())
                return compatibilityProviders(
                    path.join(directory, entry.name),
                    name
                );
            return entry.name === "provider.js" && !ids.includes(prefix)
                ? [prefix]
                : [];
        });
}
assert.deepEqual(compatibilityProviders(path.join(root, "providers")), []);
assert(ids.includes("demo") && ids.includes("xtream"));
for (const id of ids) {
    assert.equal(
        isManagedProviderScript(
            path.join(root, "providers", id, "provider.js")
        ),
        true
    );
    assert.equal(
        isManagedProviderScript(
            "C:\\runtime\\providers\\" +
                id.replace(/\//g, "\\") +
                "\\provider.js"
        ),
        true
    );
    assert.equal(
        isManagedProviderScript(path.join(root, "providers", id, "logo.png")),
        false
    );
    assert.equal(
        isManagedProviderScript(path.join(root, "providers", id, "about.html")),
        false
    );
}
assert.equal(isManagedProviderScript("providers/m3u/provider.js"), true);
assert.equal(isManagedProviderScript("providers/stalker/provider.js"), true);
assert.equal(isManagedProviderScript("providers/unknown/provider.js"), false);
assert.equal(isRetiredRuntimeScript("devices/legacy-core.js"), true);
assert.equal(
    isRetiredRuntimeScript("C:\\runtime\\devices\\legacy-core.js"),
    true
);
assert.equal(isRetiredRuntimeScript("devices/pc/device.js"), false);
assert.equal(isRetiredRuntimeScript("js/ottplay-core.js"), false);
assert(
    fs.existsSync(path.join(root, "devices/legacy-core.js")),
    "historical oracle retained"
);
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-driver-assets-"));
try {
    stagePlayProviders(root, stage);
    for (const id of ["demo", "xtream", "stalker", "m3u", "plex", "vportal"]) {
        assert(
            !fs.existsSync(path.join(stage, id, "provider.js")),
            "Play does not ship retired executable " + id
        );
        assert(
            fs.existsSync(path.join(stage, id, "about.html")),
            "UI metadata remains available"
        );
    }
} finally {
    fs.rmSync(stage, { force: true, recursive: true });
}
if (process.argv.includes("--bundle")) {
    for (const target of ["dist", "dist-mobile", "src-tauri/frontend"]) {
        assert(
            fs.existsSync(path.join(root, target)),
            "Missing built artifact: " + target
        );
        assert(
            !fs.existsSync(path.join(root, target, "devices/legacy-core.js")),
            target + " still contains retired device implementation"
        );
        for (const id of ids)
            assert(
                !fs.existsSync(
                    path.join(root, target, "providers", id, "provider.js")
                ),
                target + " still contains retired script " + id
            );
    }
}
console.log(
    "PASS provider assets: " +
        ids.length +
        " managed scripts excluded, retained compatibility and UI assets preserved" +
        (process.argv.includes("--bundle") ? " in all built roots" : "")
);
