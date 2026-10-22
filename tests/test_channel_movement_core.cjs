const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const baseline = "b3c8cc072e92f14c8e352a223157788f24ca4dce";
const capture = process.argv.includes("--capture");
const sourceText = capture
    ? execFileSync("git", ["show", baseline + ":src/channels/index.ts"], {
          cwd: root,
          encoding: "utf8",
      })
    : fs.readFileSync(path.join(root, "src/channels/index.ts"), "utf8");
const source = ts.createSourceFile(
    "channels.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true
);
const selected = new Set(["nextChannel", "prevChannel"]);
const functions = source.statements
    .filter((n) => ts.isFunctionDeclaration(n) && selected.has(n.name?.text))
    .map((n) => n.getText(source))
    .join("\n");
const code = ts
    .transpileModule(functions, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
let calls = [];
const context = vm.createContext({
    catIndex: 4,
    curList: [],
    primaryIndex: 0,
    window: { playChannel: (category, index) => calls.push([category, index]) },
});
vm.runInContext(
    fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"),
    context
);
context.window.OttPlayCore = context.OttPlayCore;
vm.runInContext(code, context);
const observed = [];
for (const count of [0, 1, 2, 5, 20])
    for (const current of [-2, -1, 0, 1, 4, 12, 1.5]) {
        context.curList = Array(count);
        context.primaryIndex = current;
        calls = [];
        context.nextChannel();
        context.prevChannel();
        observed.push({ calls, count, current });
    }
const target = path.join(
    __dirname,
    "fixtures/playback-policy/channels-before-core.json"
);
if (capture) {
    assert(!fs.existsSync(target));
    fs.writeFileSync(
        target,
        JSON.stringify({ baseline, observed }, null, 2) + "\n"
    );
} else {
    assert.deepEqual(
        observed,
        JSON.parse(fs.readFileSync(target, "utf8")).observed
    );
    console.log("PASS 35 captured classic channel movement boundary profiles");
}
