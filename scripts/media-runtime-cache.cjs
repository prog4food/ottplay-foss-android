const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("parse5");

function firstScript(node) {
    if (node.tagName === "script") return node;
    // Template contents are inert; comments and raw text are not script nodes.
    for (const child of node.childNodes || []) {
        const found = firstScript(child);
        if (found) return found;
    }
    return undefined;
}

async function auditSourceRuntime(runtime, root) {
    const manifest = await runtime.auditMediaRuntime(root);
    // The shared auditor also checks staged trees, where these source paths
    // are optional. A source build must require both real entry points.
    for (const file of ["index.html", "src-tauri/pip/pip.html"]) {
        const html = fs.readFileSync(path.join(root, file), "utf8");
        const script = firstScript(parse(html));
        const message = "Missing or non-blocking media bootstrap: " + file;
        assert(script, message);
        const attrs = Object.fromEntries(
            script.attrs.map((attribute) => [attribute.name, attribute.value])
        );
        const expected = "js/runtime-polyfills.js?v=" + manifest.runtimeVersion;
        assert(
            attrs.src === "/" + expected || attrs.src === "./" + expected,
            "Stale or out-of-order media bootstrap: " + file
        );
        const type = (attrs.type || "").trim().toLowerCase();
        const language = (attrs.language || "").trim().toLowerCase();
        const effectiveType = type || (language ? "text/" + language : "");
        assert(
            (!effectiveType ||
                /^(?:text|application)\/(?:java|ecma)script$/.test(
                    effectiveType
                )) &&
                !Object.hasOwn(attrs, "async") &&
                !Object.hasOwn(attrs, "defer") &&
                !Object.hasOwn(attrs, "nomodule"),
            message
        );
    }
    return manifest;
}

async function ensureMediaRuntime(
    directory = path.resolve(__dirname, ".."),
    dependencies
) {
    const root = path.resolve(directory);
    // Load the builder from the requested source tree: its inputs and writes
    // are rooted at its own module directory, not at the current working directory.
    const runtime =
        dependencies || require(path.join(root, "scripts/media-runtime.cjs"));
    try {
        // Never reuse a previous result or trust timestamps. The existing audit
        // checks current inputs, asset hashes, ES5, upstream bytes, worker
        // bootstrap, license texts and versioned entry-point URLs each time.
        const manifest = await auditSourceRuntime(runtime, root);
        return { manifest, rebuilt: false };
    } catch (_staleRuntime) {
        // An incomplete or stale runtime must be regenerated before staging.
    }
    await runtime.buildMediaRuntime();
    // Do not swallow rebuild or post-build audit failures, even if an older
    // runtime was present. A failed repair must stop the consuming build.
    const manifest = await auditSourceRuntime(runtime, root);
    return { manifest, rebuilt: true };
}

module.exports = { ensureMediaRuntime };
if (require.main === module) {
    ensureMediaRuntime()
        .then(({ rebuilt }) => {
            console.log(
                rebuilt
                    ? "Media runtime rebuilt and verified"
                    : "Media runtime inputs and assets verified"
            );
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
