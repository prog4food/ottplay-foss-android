// Test-only hosted launcher: exercise automatic detection at the server root.
// The vendor SDK is installed separately; no SDK files or product IPK are built.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "build/device-webos-simulator");
let target = process.env.OTTP_PLAYER_URL;
if (!target) {
    const port = Number(process.env.OTTP_DEVICE_TEST_PORT || 8443);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("OTTP_DEVICE_TEST_PORT must be a valid TCP port");
    target = "http://127.0.0.1:" + port + "/";
}
let playerUrl;
try {
    playerUrl = new URL(target);
    if (
        !["http:", "https:"].includes(playerUrl.protocol) ||
        playerUrl.username ||
        playerUrl.password
    )
        throw new Error("Unsupported player URL");
} catch (_) {
    throw new Error(
        "OTTP_PLAYER_URL must be an HTTP(S) URL without credentials"
    );
}
if (process.argv[2] === "--print-url" && process.argv.length === 3) {
    console.log(playerUrl.href);
    process.exit(0);
}
if (process.argv.length !== 2) throw new Error("Unknown preparation option");
// Hosted apps use the deployed build; local dist/ is not required.
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(
    path.join(destination, "appinfo.json"),
    JSON.stringify(
        {
            disableBackHistoryAPI: true,
            icon: "icon.png",
            id: "com.openottplay.devicedetection",
            main: "index.html",
            title: "OTT device detection test",
            type: "web",
            vendor: "open-ott-play",
            version: "0.0.1",
        },
        null,
        2
    ) + "\n"
);
fs.copyFileSync(
    path.join(root, "images/player-logo.png"),
    path.join(destination, "icon.png")
);
fs.writeFileSync(
    path.join(destination, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><title>OTT device test</title></head>' +
        "<body><script>location.replace(" +
        JSON.stringify(playerUrl.href).replace(/</g, "\\u003c") +
        ");</script></body></html>\n"
);
console.log("Simulator app directory: " + destination);
console.log("Player target: " + playerUrl.href);
console.log(
    "Use ottplay-server for EPG, or the static device-browser-server.cjs for detection/button checks only."
);
console.log(
    "Then use the LG Simulator File > Launch App menu to select this directory."
);
