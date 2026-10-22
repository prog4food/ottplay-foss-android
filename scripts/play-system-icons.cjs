const fs = require("node:fs");
const path = require("node:path");

// Only the 17 glyphs used by the player are mapped. These are ordinary BMP
// text characters, without emoji presentation or a bundled icon font.
const PLAY_SYSTEM_ICONS = Object.freeze({
    0xe80a: "▼",
    0xe80b: "▲",
    0xe80c: "◂",
    0xe80d: "▸",
    0xe80e: "AБ",
    0xe802: "»",
    0xe803: "«",
    0xe804: "×",
    0xe805: "▸|",
    0xe806: "|◂",
    0xe808: "≡",
    0xe810: "i",
    0xe811: "▸",
    0xe812: "■",
    0xe813: "‖",
    0xf204: "□",
    0xf205: "✓",
});

function isPrivateUse(codepoint) {
    return codepoint >= 0xe000 && codepoint <= 0xf8ff;
}

function containsPrivateUse(text) {
    return (
        /[\ue000-\uf8ff]/.test(text) ||
        Array.from(
            text.matchAll(/\\u(?:([\da-f]{4})|\{([\da-f]{1,6})\})/gi)
        ).some((match) =>
            isPrivateUse(Number.parseInt(match[1] || match[2], 16))
        ) ||
        Array.from(text.matchAll(/\\([\da-f]{4,6})(?=\s|["';}]|$)/gi)).some(
            (match) => isPrivateUse(Number.parseInt(match[1], 16))
        ) ||
        Array.from(text.matchAll(/&#(x[\da-f]+|\d+);/gi)).some((match) =>
            isPrivateUse(
                match[1][0].toLowerCase() === "x"
                    ? Number.parseInt(match[1].slice(1), 16)
                    : Number(match[1])
            )
        )
    );
}

function transformPlaySystemIcons(text, css = false) {
    function glyph(codepoint, original) {
        if (!isPrivateUse(codepoint)) return original;
        if (!Object.hasOwn(PLAY_SYSTEM_ICONS, codepoint)) {
            throw new Error(
                "Unmapped Play icon: U+" + codepoint.toString(16).toUpperCase()
            );
        }
        return PLAY_SYSTEM_ICONS[codepoint];
    }
    if (css) {
        text = text.replace(
            /\/\* FONTELLO - BEGIN \*\/[\s\S]*?\/\* FONTELLO - END \*\//g,
            ""
        );
        if (/@font-face\s*\{[^}]*fontello/i.test(text)) {
            throw new Error("Unexpected Play icon font-face declaration");
        }
    }
    if (/fontello\.(?:eot|ttf|woff2?|svg)/i.test(text)) {
        throw new Error("Unexpected Play icon font resource reference");
    }
    text = text
        .replace(/&#(x[\da-f]+|\d+);/gi, (original, number) =>
            glyph(
                number[0].toLowerCase() === "x"
                    ? Number.parseInt(number.slice(1), 16)
                    : Number(number),
                original
            )
        )
        .replace(/\\u([\da-f]{4})/gi, (original, number) =>
            glyph(Number.parseInt(number, 16), original)
        )
        .replace(/[\ue000-\uf8ff]/g, (original) =>
            glyph(original.charCodeAt(0), original)
        )
        .replace(
            /font-family\s*:\s*(?:["']fontello["']|fontello)(?=\s*[;}])/gi,
            "font-family: sans-serif"
        )
        .replace(/\bfontello\b/gi, "system-icons");
    if (containsPrivateUse(text)) {
        throw new Error("Private-use icon remains in Play frontend");
    }
    return text;
}

function stagePlaySystemIcons(directory) {
    const fonts = path.join(directory, "fonts");
    for (const name of fs.readdirSync(fonts)) {
        if (/^fontello\./i.test(name)) {
            fs.rmSync(path.join(fonts, name));
        }
    }
    function visit(folder) {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isSymbolicLink())
                throw new Error("Symlink in Play assets");
            if (entry.isDirectory()) visit(file);
            else if (/\.(js|html|css)$/i.test(entry.name)) {
                const text = fs.readFileSync(file, "utf8");
                const transformed = transformPlaySystemIcons(
                    text,
                    entry.name.endsWith(".css")
                );
                if (text !== transformed) fs.writeFileSync(file, transformed);
            }
        }
    }
    visit(directory);
    fs.appendFileSync(
        path.join(directory, "styles/player.css"),
        "\n/* System text symbols keep menu values and paired controls aligned. */\n" +
            ".system-icons { font-family: sans-serif; display: inline-block; " +
            "min-width: 1em; text-align: center; white-space: nowrap; " +
            "letter-spacing: normal; }\n"
    );
}

module.exports = {
    containsPrivateUse,
    PLAY_SYSTEM_ICONS,
    stagePlaySystemIcons,
    transformPlaySystemIcons,
};
