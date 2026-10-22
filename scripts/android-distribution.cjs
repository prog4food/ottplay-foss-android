const fs = require("node:fs");
const path = require("node:path");
const { isManagedProviderScript } = require("./provider-assets.cjs");

const PLAY_PROVIDERS = [
    "demo",
    "offline",
    "m3u",
    "plex",
    "stalker",
    "vportal",
    "xtream",
];

function transformDistribution(code, flavor) {
    if (!["full", "play"].includes(flavor))
        throw new Error("Unknown distribution");
    let depth = 0;
    let regions = 0;
    const lines = [];
    for (const line of code.split("\n")) {
        if (line.trim() === "// OTTPLAY_FULL_ONLY_BEGIN") {
            if (depth++) throw new Error("Nested distribution region");
            regions++;
        } else if (line.trim() === "// OTTPLAY_FULL_ONLY_END") {
            if (--depth !== 0) throw new Error("Unmatched distribution end");
        } else if (flavor === "full" || !depth) {
            lines.push(line);
        }
    }
    if (depth) throw new Error("Unclosed distribution region");
    return { code: lines.join("\n"), regions };
}

function prepareDistributionModules(root, flavor) {
    const providerFile = path.join(root, "build/provider/index.js");
    const provider = fs.readFileSync(providerFile, "utf8");
    const marker = /var providerDistribution = "full";/g;
    if ((provider.match(marker) || []).length !== 1) {
        throw new Error("Provider distribution marker is missing or ambiguous");
    }
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
        })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.name.endsWith(".js")) {
                const result = transformDistribution(
                    fs.readFileSync(file, "utf8"),
                    flavor
                );
                if (file === providerFile && result.regions < 2) {
                    throw new Error(
                        "Provider catalog distribution regions missing"
                    );
                }
                fs.writeFileSync(
                    file,
                    file === providerFile
                        ? result.code.replace(
                              marker,
                              'var providerDistribution = "' + flavor + '";'
                          )
                        : result.code
                );
            }
        }
    }
    visit(path.join(root, "build"));
}

function stagePlayProviders(root, destination) {
    fs.rmSync(destination, { force: true, recursive: true });
    const descriptions = {
        demo: "An original synthetic video test pattern for checking playback. No broadcast content is included.",
        m3u: "Open an M3U playlist that you are authorized to use. No television subscription or channels are included.",
        offline:
            "Play files imported into local device storage without a network connection.",
        plex: "Connect to your own Plex server and browse its libraries and folders. Server settings are stored on this device.",
        stalker:
            "Connect to your authorized Stalker portal using its address and credentials. No portal subscription is included.",
        vportal:
            "Open your VPortal media library with independently saved profiles.",
        xtream: "Connect using your authorized Xtream-compatible server address and credentials. No subscription is included.",
    };
    for (const id of PLAY_PROVIDERS) {
        const dir = path.join(destination, id);
        fs.mkdirSync(dir, { recursive: true });
        if (
            !isManagedProviderScript(
                path.join(root, "providers", id, "provider.js")
            )
        )
            fs.copyFileSync(
                path.join(root, "providers", id, "provider.js"),
                path.join(dir, "provider.js")
            );
        fs.writeFileSync(path.join(dir, "about.html"), descriptions[id] + "\n");
        if (id === "demo")
            fs.writeFileSync(
                path.join(dir, "about-ru.html"),
                descriptions[id] + "\n"
            );
    }
}

module.exports = {
    PLAY_PROVIDERS,
    prepareDistributionModules,
    stagePlayProviders,
    transformDistribution,
};
