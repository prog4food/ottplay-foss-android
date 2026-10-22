const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    checkGenerated,
    expectedReadmes,
    renderQuickStart,
} = require("../scripts/generate-readmes.cjs");
const {
    checkDocumentation,
    checkLinks,
} = require("../scripts/check-readme-docs.cjs");
const {
    languageAssets,
    readDictionary,
} = require("../scripts/localization-catalog.cjs");
const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-readme-docs-"));
try {
    const english = readDictionary(path.join(root, "locales/english.js"));
    assert.throws(
        () => renderQuickStart({ ...english, "Load playlist": "" }),
        /Missing quick-start/
    );
    const escaped = renderQuickStart({
        ...english,
        lang: "Name [link](bad) <script>",
    });
    assert(escaped.includes("Name \\[link\\](bad) \\<script\\>"));
    assert(!escaped.includes("Name [link](bad)"));
    const generated = expectedReadmes(root);
    assert.equal(generated.size, Object.keys(languageAssets).length + 1);
    assert(
        generated
            .get("docs/readme/russian/README.md")
            .includes("Настройки → Сменить провайдера")
    );
    assert(generated.get("docs/readme/arabic/README.md").includes("العربية"));
    assert(
        generated
            .get("docs/readme/arabic/README.md")
            .includes('<div dir="rtl">')
    );
    assert(
        !generated
            .get("docs/readme/english/README.md")
            .includes('<div dir="rtl">')
    );
    for (const asset of Object.values(languageAssets)) {
        const output = path.join(fixture, asset);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.copyFileSync(path.join(root, asset), output);
    }
    for (const [file, content] of generated) {
        const output = path.join(fixture, file);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, content);
    }
    assert.deepEqual(checkGenerated(fixture), []);
    const guide = path.join(fixture, "docs/readme/english/README.md");
    fs.appendFileSync(guide, "drift\n");
    assert(
        checkGenerated(fixture).some((error) =>
            error.includes("english/README.md")
        )
    );
    fs.mkdirSync(path.join(fixture, "docs/readme/retired"));
    assert(
        checkGenerated(fixture).some((error) =>
            error.includes("Unknown locale")
        )
    );
    fs.writeFileSync(path.join(fixture, "README.md"), "# Title\n");
    fs.writeFileSync(path.join(fixture, "a file.md"), "# A\n");
    fs.writeFileSync(
        path.join(fixture, "links.md"),
        [
            "[exists](README.md#heading)",
            "[spaces](<a file.md>)",
            "[external](https://example.invalid/absent.md)",
            "[missing](missing.md)",
            "![missing image](image.svg)",
            "[escape](../outside.md)",
            "```md\n[example](not-real.md)\n```",
        ].join("\n")
    );
    const errors = checkLinks(fixture, "links.md");
    assert.equal(errors.length, 3);
    assert(errors.some((error) => error.includes("missing.md")));
    assert(errors.some((error) => error.includes("image.svg")));
    assert(errors.some((error) => error.includes("escapes repository")));
} finally {
    fs.rmSync(fixture, { force: true, recursive: true });
}
const errors = checkDocumentation(root);
assert.deepEqual(errors, [], errors.join("\n"));
console.log(
    "PASS README generation, locale parity, escaping, drift and file links"
);
