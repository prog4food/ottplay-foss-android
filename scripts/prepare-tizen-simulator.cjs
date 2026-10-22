// Experimental server UI check. Samsung does not support hosted applications
// in the simulator; this redirect is not a firmware, AVPlay or DRM test.
const fs = require("node:fs");
const path = require("node:path");

const destination = path.resolve(__dirname, "../build/device-tizen-simulator");
let playerUrl;
try {
    playerUrl = new URL(
        process.env.OTTP_PLAYER_URL || "http://127.0.0.1:8443/"
    );
    if (
        !["http:", "https:"].includes(playerUrl.protocol) ||
        playerUrl.username ||
        playerUrl.password
    )
        throw new Error("Unsupported URL");
} catch (_) {
    throw new Error(
        "OTTP_PLAYER_URL must be an HTTP(S) URL without credentials"
    );
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--print-url") {
    console.log(playerUrl.href);
    process.exit(0);
}
if (args.length) throw new Error("Unknown preparation option");
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(
    path.join(destination, "config.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="http://open-ott-play.github.io/simulator-check" version="1.0.0" viewmodes="maximized">\n' +
        '  <tizen:application id="OttSimTest.ServerCheck" package="OttSimTest" required_version="2.3"/>\n' +
        "  <name>OTT local server check</name>\n" +
        '  <content src="index.html"/>\n' +
        '  <tizen:profile name="tv-samsung"/>\n' +
        '  <tizen:privilege name="http://tizen.org/privilege/internet"/>\n' +
        '  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>\n' +
        "</widget>\n"
);
fs.writeFileSync(
    path.join(destination, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>OTT local server check</title></head>' +
        "<body><p>Opening OTT server for an experimental simulator UI check.</p><script>location.replace(" +
        JSON.stringify(playerUrl.href).replace(/</g, "\\u003c") +
        ");</script></body></html>\n"
);
console.log("Simulator app directory: " + destination);
console.log("Player target: " + playerUrl.href);
console.log("Run scripts/run-tizen-simulator.sh to open the local player");
console.log(
    "Hosted UI experiment only: Samsung API timing and media playback are not guaranteed."
);
