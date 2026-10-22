const assert = require("node:assert/strict");
const fs = require("node:fs");

function verifyHost(platform, architecture, release) {
    assert.equal(platform, "linux", "Linux WebKit requires Linux");
    assert.equal(architecture, "x64", "Linux WebKit requires x64");
    assert.match(release, /^ID=(?:ubuntu|"ubuntu")$/m, "Expected Ubuntu");
    assert.match(
        release,
        /^VERSION_ID=(?:26\.04|"26\.04")$/m,
        "Linux WebKit requires Ubuntu 26.04"
    );
    return { architecture, os: "ubuntu", version: "26.04" };
}

if (require.main === module) {
    console.log(
        JSON.stringify(
            verifyHost(
                process.platform,
                process.arch,
                fs.readFileSync("/etc/os-release", "utf8")
            )
        )
    );
}

module.exports = { verifyHost };
