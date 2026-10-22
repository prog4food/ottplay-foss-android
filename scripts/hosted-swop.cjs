const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** Extract the finite page vocabulary instead of maintaining another catalog. */
function phoneKeys(html, source) {
    const ts = require("typescript");
    const keys = new Set();
    for (const match of html.matchAll(/data-i18n="([^"]+)"/g))
        keys.add(match[1]);
    const ast = ts.createSourceFile(
        "phone.ts",
        source,
        ts.ScriptTarget.Latest,
        true
    );
    function visit(node) {
        if (ts.isCallExpression(node)) {
            const name = node.expression.getText(ast);
            const index = name === "locale.label" ? 1 : 0;
            const value = node.arguments[index];
            if (["say", "locale.label", "locale.text"].includes(name)) {
                var parent = node.parent;
                while (parent && !ts.isFunctionDeclaration(parent))
                    parent = parent.parent;
                if (name === "locale.label" && parent?.name?.text === "say")
                    return;
                if (!value || !ts.isStringLiteral(value))
                    throw new Error(
                        "Phone translation must use a literal key: " +
                            node.getText(ast)
                    );
                keys.add(value.text);
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return [...keys].sort();
}

/** Run after tsc. Adds only a self-contained, same-origin input page. */
async function stageHostedSwop(
    outputRoot,
    compileRoot = path.join(__dirname, "../build")
) {
    const { rollup } = require("rollup");
    const { nodeResolve } = require("@rollup/plugin-node-resolve");
    const { minify } = require("terser");
    const directory = path.join(outputRoot, "swop-input");
    fs.mkdirSync(directory, { recursive: true });
    const root = path.resolve(__dirname, "..");
    const source = fs.readFileSync(
        path.join(root, "src/swop/herenow-phone.ts"),
        "utf8"
    );
    const keys = phoneKeys(PHONE_HTML, source);
    const {
        languageAssets,
        readDictionary,
    } = require("./localization-catalog.cjs");
    const localeFiles = {};
    fs.mkdirSync(path.join(directory, "locales"), { recursive: true });
    for (const [code, asset] of Object.entries(languageAssets)) {
        const catalog = readDictionary(path.join(root, asset));
        const values = {};
        for (const key of keys) {
            if (typeof catalog[key] !== "string" || !catalog[key])
                throw new Error(
                    "Missing phone translation: " + code + " / " + key
                );
            values[key] = catalog[key];
        }
        const bytes = JSON.stringify(values) + "\n";
        const name =
            code.slice(1) +
            "-" +
            createHash("sha256").update(bytes).digest("hex").slice(0, 16) +
            ".json";
        fs.writeFileSync(path.join(directory, "locales", name), bytes);
        localeFiles[code] = "/swop-input/locales/" + name;
    }
    const bundle = await rollup({
        input: path.join(compileRoot, "swop/herenow-phone.js"),
        onwarn(warning) {
            if (warning.code !== "THIS_IS_UNDEFINED")
                throw new Error(warning.message);
        },
        plugins: [nodeResolve()],
    });
    const generated = await bundle.generate({
        format: "iife",
        intro:
            "var __OTT_PHONE_LOCALES__ = " + JSON.stringify(localeFiles) + ";",
        name: "OttPlayHereNowInput",
    });
    await bundle.close();
    const result = await minify(generated.output[0].code, {
        compress: { ecma: 5 },
        ecma: 5,
        format: { ecma: 5 },
        mangle: true,
    });
    require("acorn").parse(result.code, { ecmaVersion: 5 });
    fs.writeFileSync(path.join(directory, "app.js"), result.code + "\n");
    fs.writeFileSync(path.join(directory, "index.html"), PHONE_HTML);
}
const PHONE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'">
<title>OTT-play — remote text input</title><style>
*{box-sizing:border-box}body{margin:0;background:#101722;color:#edf2f9;font:17px system-ui,sans-serif;line-height:1.5}main{max-width:640px;margin:5vh auto;padding:24px}h1{font-size:28px}label{display:block;margin:20px 0 8px}textarea{width:100%;min-height:140px;padding:12px;border:1px solid #53637a;border-radius:8px;background:#192637;color:inherit;font:inherit;resize:vertical}button{padding:12px 18px;margin:16px 12px 0 0;border:0;border-radius:8px;background:#a9d0ff;color:#10213a;font:inherit;cursor:pointer}button:disabled{opacity:.5}#cancel{background:#28394f;color:inherit}[hidden]{display:none!important}#status{color:#b9c9dd;min-height:3em}small{color:#b9c9dd}
</style></head><body><main><h1 data-i18n="OTT-play remote input">OTT-play remote input</h1><p id="status" role="status" data-i18n="Scan the QR code on your TV, or paste its complete private pairing link below.">Scan the QR code on your TV, or paste its complete private pairing link below.</p>
<form id="pairing"><label for="link" data-i18n="Complete pairing link">Complete pairing link</label><textarea id="link" dir="ltr" autocomplete="off" spellcheck="false" aria-describedby="privacy"></textarea><small id="privacy" data-i18n="Use the full link, including the part after #. Do not share it with anyone else.">Use the full link, including the part after #. Do not share it with anyone else.</small><br><button type="submit" data-i18n="Connect to TV">Connect to TV</button></form>
<form id="entry" hidden><label id="caption" for="value" data-i18n="Enter text">Enter text</label><textarea id="value" dir="auto" autocomplete="off" spellcheck="false"></textarea><button id="send" type="submit" data-i18n="Send to TV">Send to TV</button><button id="cancel" type="button" data-i18n="Cancel">Cancel</button></form>
</main><script src="/local/hosted.js"></script><script src="./app.js"></script></body></html>\n`;
module.exports = { PHONE_HTML, phoneKeys, stageHostedSwop };
if (require.main === module) {
    if (!process.argv[2])
        throw new Error("Usage: node scripts/hosted-swop.cjs OUTPUT_ROOT");
    stageHostedSwop(path.resolve(process.argv[2])).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
