#!/usr/bin/env node
"use strict";

// Export reviewed source documentation; publishing remains an explicit Git push.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const root = path.resolve(__dirname, "..");
const target = process.argv[2];
const revision =
    process.argv[3] ||
    cp
        .execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
        })
        .trim();
if (!target || !/^[a-f0-9]{40}$/.test(revision)) {
    console.error(
        "Usage: node scripts/export-wiki.cjs WIKI_CHECKOUT [FULL_SOURCE_SHA]"
    );
    process.exit(1);
}
const destination = path.resolve(target);
if (destination === root || destination.startsWith(root + path.sep))
    throw new Error("Use a separate wiki checkout");
const repository = "https://github.com/open-ott-play/ottplay-foss";
const wiki = repository + "/wiki/";
const raw =
    "https://raw.githubusercontent.com/wiki/open-ott-play/ottplay-foss/";
const pages = {
    "docs/wiki/_Sidebar.md": "_Sidebar",
    "docs/wiki/Home.md": "Home",
    "docs/wiki/Home.ru.md": "Home-RU",
};
for (const name of [
    "roadmap-delivery",
    "implementation-report",
    "browser-compatibility",
    "roadmap-size",
    "playback-stream-policy",
    "guide-binding-accessibility",
    "audio-video-check",
    "xtream-media",
    "remote-handoff",
    "settings-recovery",
]) {
    pages["docs/" + name + ".md"] = name;
    pages["docs/" + name + ".ru.md"] = name + "-RU";
}
function sourceBytes(file) {
    return cp.execFileSync("git", ["show", revision + ":" + file], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
    });
}
function sourceExists(file) {
    return (
        cp.spawnSync("git", ["cat-file", "-e", revision + ":" + file], {
            cwd: root,
            stdio: "ignore",
        }).status === 0
    );
}
const assets = new Set();
fs.mkdirSync(destination, { recursive: true });
for (const [source, page] of Object.entries(pages)) {
    let content = sourceBytes(source).toString("utf8");
    content = content.replace(
        /(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g,
        (match, prefix, href, suffix) => {
            if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return match;
            const hash = href.indexOf("#");
            const fragment = hash < 0 ? "" : href.slice(hash);
            const relative = hash < 0 ? href : href.slice(0, hash);
            const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(source), relative)
            );
            if (resolved.startsWith("../") || !sourceExists(resolved))
                throw new Error(
                    "Missing documentation link: " + source + " -> " + href
                );
            let url;
            if (pages[resolved]) url = wiki + pages[resolved];
            else if (prefix.startsWith("![") && /\.svg$/.test(resolved)) {
                const name = "assets/" + path.posix.basename(resolved);
                assets.add(resolved);
                url = raw + name;
            } else url = repository + "/blob/" + revision + "/" + resolved;
            return prefix + url + fragment + suffix;
        }
    );
    if (page !== "_Sidebar")
        content +=
            "\n---\n\nSource revision: [" +
            revision.slice(0, 8) +
            "](" +
            repository +
            "/tree/" +
            revision +
            "). This documentation may describe changes awaiting release; use the matching build.\n";
    fs.writeFileSync(path.join(destination, page + ".md"), content);
}
fs.mkdirSync(path.join(destination, "assets"), { recursive: true });
for (const asset of assets)
    fs.writeFileSync(
        path.join(destination, "assets", path.basename(asset)),
        sourceBytes(asset)
    );
console.log(
    "Exported " +
        Object.keys(pages).length +
        " pages and " +
        assets.size +
        " SVG assets for " +
        revision.slice(0, 8)
);
