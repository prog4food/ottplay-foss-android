const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const bundle = process.argv.includes("--bundle");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functions(file, names) {
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = new Map();
    function include(name) {
        if (selected.has(name)) return;
        const declarations = ast.statements.filter(
            (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
        );
        assert.equal(
            declarations.length,
            1,
            `${file}: actual ${name} declaration`
        );
        const declaration = declarations[0];
        selected.set(name, declaration.getText(ast));
        function visit(node) {
            if (ts.isIdentifier(node) && /^__ottReadImport\d+$/.test(node.text))
                include(node.text);
            ts.forEachChild(node, visit);
        }
        visit(declaration);
    }
    names.forEach(include);
    const text = [...selected.values()].join("\n");
    return bundle
        ? text
        : ts
              .transpileModule(text, {
                  compilerOptions: {
                      module: ts.ModuleKind.ES2015,
                      target: ts.ScriptTarget.ES5,
                  },
              })
              .outputText.replace(/^export /gm, "");
}

const code = bundle
    ? functions("dist/player.js", [
          "_enterPinCode",
          "cancelNativeListInertia",
          "dispatchKey",
          "keyHandler",
          "stbEventToKeyCode",
      ])
    : functions("src/channels/index.ts", ["_enterPinCode"]) +
      functions("src/key-handler/index.ts", [
          "cancelNativeListInertia",
          "dispatchKey",
          "keyHandler",
      ]) +
      functions("src/core/index.ts", ["stbEventToKeyCode"]);
const adapters = {};
for (const name of [
    "android",
    "pc",
    "lg/webos",
    "lg/netcast",
    "samsung/tizen",
    "samsung/maple",
    "dune",
    "mag",
]) {
    const file = `src/devices/${name}/device.ts`;
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const declaration = ast.statements
        .filter(ts.isVariableStatement)
        .flatMap((node) => [...node.declarationList.declarations])
        .find((node) => /Keys$/.test(node.name.getText(ast)));
    assert.ok(declaration?.initializer, `${name}: real adapter key map`);
    adapters[name] = JSON.parse(
        JSON.stringify(
            require("node:vm").runInNewContext(
                `(${declaration.initializer.getText(ast)})`
            )
        )
    );
}
// Expose any remaining arithmetic assumption for device-specific digit codes.
adapters.sparse = {
    ...adapters.pc,
    ...Object.fromEntries(
        Array.from({ length: 10 }, (_, digit) => [
            `N${digit}`,
            1000 + digit * 13,
        ])
    ),
};

for (const [adapter, keys] of Object.entries(adapters)) {
    // Real rendered buttons and inline click handlers; no resources or network.
    const dom = new JSDOM('<div id="dialogbox" style="display:none"></div>', {
        runScripts: "dangerously",
        url: "https://example.invalid/",
    });
    const w = dom.window;
    require("./helpers/screen-runtime.cjs")(w);
    require("./helpers/access-runtime.cjs")(w);
    try {
        w.eval(read("js/jquery-1.11.1.min.js"));
        const originalIs = w.$.fn.is;
        w.$.fn.is = function (selector) {
            // JSDOM has no layout; retain jQuery's production visibility query.
            return selector === ":visible"
                ? Boolean(this[0] && this[0].style.display !== "none")
                : originalIs.call(this, selector);
        };
        w.keys = keys;
        w.nativeListInertia = null;
        w.eval(code);
        w._doKey = w.dispatchKey;
        w.addEventListener("keydown", w.keyHandler);
        let bodyClicks = 0;
        w.document.body.addEventListener("click", () => bodyClicks++);
        const results = [];
        const open = () => {
            results.length = 0;
            w._enterPinCode("Test parental code", (value) =>
                results.push(value)
            );
        };
        const marks = () =>
            (w.document.getElementById("pin").textContent.match(/#/g) || [])
                .length;
        const enter = (mode, digit) => {
            if (mode === "click")
                w.document.querySelector(`#k${digit} .btn`).click();
            else if (mode === "host") w._doKey(keys[`N${digit}`]);
            else
                w.document.body.dispatchEvent(
                    new w.KeyboardEvent("keydown", {
                        bubbles: true,
                        cancelable: true,
                        keyCode: keys[`N${digit}`],
                    })
                );
        };

        for (const mode of ["click", "host", "keyboard"]) {
            for (let digit = 0; digit < 10; digit++) {
                open();
                enter(mode, digit);
                assert.equal(
                    marks(),
                    1,
                    `${adapter}/${mode}: one press adds exactly one masked digit`
                );
                assert.equal(
                    results.length,
                    0,
                    `${adapter}/${mode}: one digit cannot submit`
                );
                w._doKey(keys.RETURN);
                assert.deepEqual(
                    results,
                    [""],
                    `${adapter}/${mode}: cancel clears partial entry`
                );
            }
            open();
            // Explicit test-only input; never read persisted or user-provided PINs.
            for (const [index, digit] of [..."1209"].entries()) {
                enter(mode, Number(digit));
                assert.equal(
                    marks(),
                    index + 1,
                    `${adapter}/${mode}: mask tracks exact input length`
                );
                assert.equal(
                    results.length,
                    index === 3 ? 1 : 0,
                    `${adapter}/${mode}: submit only at fourth press`
                );
            }
            assert.deepEqual(
                results,
                ["1209"],
                `${adapter}/${mode}: four selected digits preserved`
            );
            assert.equal(
                w.dialogBoxKeyHandler,
                null,
                `${adapter}/${mode}: completed dialog releases handler`
            );
            assert.equal(w.$("#dialogbox").is(":visible"), false);
        }
        open();
        // Initial highlight is 1. Exercise ENTER, wrap to 0, and both arrow axes.
        w._doKey(keys.ENTER);
        w._doKey(keys.RIGHT);
        w._doKey(keys.ENTER);
        w._doKey(keys.UP);
        w._doKey(keys.LEFT);
        w._doKey(keys.ENTER);
        w._doKey(keys.UP);
        w._doKey(keys.ENTER);
        assert.deepEqual(
            results,
            ["1209"],
            `${adapter}: ENTER uses the highlighted digit's actual key code`
        );
        assert.equal(
            bodyClicks,
            0,
            `${adapter}: PIN clicks, including completion, cannot reach video controls`
        );
    } finally {
        dom.window.close();
    }
}
console.log(
    `PASS parental PIN input (${bundle ? "classic bundle" : "source"}): one digit per actual click/host/key event, four-digit completion, cancel, and remote selection across device maps`
);
