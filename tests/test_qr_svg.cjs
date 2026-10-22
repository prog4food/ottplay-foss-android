const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const ts = require("typescript");
const { assertQrSvg } = require("./helpers/qr-svg.cjs");

const source = fs.readFileSync(
    path.join(__dirname, "../src/utils/qr-code.ts"),
    "utf8"
);
const code = ts
    .transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
acorn.parse(code, { ecmaVersion: 5 });
// No DOM, modern encoding API or browser-only SVG implementation is required.
const context = vm.createContext({});
context.window = context;
vm.runInContext(code, context);
const payloads = [
    "",
    "012345678901234567890123456789",
    "HELLO WORLD 123",
    "https://ott.example/invite?token=abc-123&name=Living%20Room",
    "Привет, мир! Телевизор 📺 — 東京",
    "https://example.test/?value=<script>\"&other='quoted'",
    "A".repeat(800),
    "x".repeat(2200),
];
const metrics = [];
for (const payload of payloads) metrics.push(assertQrSvg(context, payload));

for (const [size, expected] of [
    [undefined, 240],
    [0, 240],
    [-1, 240],
    [300.9, 300],
]) {
    const svg = context.makeQrSvg("size", size);
    assert.ok(svg.includes(`width="${expected}" height="${expected}"`));
}
assert.equal(context.makeQrSvg(null), context.makeQrSvg(""));
assert.equal(context.makeQrSvg(undefined), context.makeQrSvg(""));
assert.equal(context.makeQrSvg(123), context.makeQrSvg("123"));
assert.throws(() => context.makeQrSvg("x".repeat(10000)), /Data too long/);
console.log(
    "QR SVG: 8 differential matrices, sizing/coercion, capacity and ES5 PASS"
);
if (process.argv.includes("--metrics")) console.log(JSON.stringify(metrics));
