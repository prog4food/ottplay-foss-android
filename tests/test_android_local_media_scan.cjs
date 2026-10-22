const assert = require("node:assert/strict");
const fs = require("node:fs");
const source = fs.readFileSync(
    "android/app/src/main/java/play/ott/foss/LocalMediaPlugin.kt",
    "utf8"
);
const link = source.slice(
    source.indexOf("private fun link("),
    source.indexOf("@ActivityCallback private fun selected(")
);
const scan = source.slice(
    source.indexOf("private fun scanTree("),
    source.indexOf("@ActivityCallback private fun selectedFolder(")
);
assert(
    !link.includes("metadata()"),
    "link must not enumerate metadata for every document"
);
assert.match(link, /uri\.toString\(\) in known/);
assert.match(link, /known\.add\(uri\.toString\(\)\)/);
assert.equal(
    (scan.match(/metadata\(\)/g) || []).length,
    1,
    "build one URI index per tree scan"
);
assert.match(
    scan,
    /catch \(_: UnavailableDocument\)/,
    "only expected source failures may be skipped"
);
assert(
    !scan.includes("catch (_: Exception)"),
    "limits and lifecycle failures must propagate"
);
assert.match(scan, /check\(!destroyed\)/);
assert.match(scan, /require\(\+\+count <= 20000\)/);
console.log("Android local media scan source contract passed");
