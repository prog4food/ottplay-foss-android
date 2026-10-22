// Exercise the real Play stager with production UI declarations and renderers.
// No network, media decoding, native font rendering or frontend build is run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const { stagePlaySystemIcons } = require("../scripts/play-system-icons.cjs");
const root = path.resolve(__dirname, "..");
let cases = 0;
function test(name, run) {
    run();
    cases++;
    console.log("PASS Play system icons: " + name);
}

function source(file) {
    return ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
}
function declarations(ast, names, includeIcons = false) {
    const found = new Set();
    const text = [];
    for (const node of ast.statements) {
        if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
            found.add(node.name.text);
            text.push(node.getText(ast).replace(/^export\s+/, ""));
        } else if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                const name = declaration.name.getText(ast);
                if (
                    names.includes(name) ||
                    (includeIcons &&
                        /^str/.test(name) &&
                        declaration.initializer
                            ?.getText(ast)
                            .includes("fontello"))
                ) {
                    found.add(name);
                    text.push("var " + declaration.getText(ast) + ";");
                }
            }
        }
    }
    for (const name of names)
        assert(found.has(name), "production declaration missing: " + name);
    return ts.transpileModule(text.join("\n"), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            removeComments: true,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
const ui = source("src/ui/index.ts");
const localization = declarations(source("src/localization/index.ts"), [
    "translations",
    "useGraphicIcons",
    "translate",
    "_",
]);
const keyboard = declarations(
    ui,
    [
        "editPos",
        "_keyCur",
        "_keyP",
        "_keys1",
        "_keysA",
        "_keysL",
        "_keysP",
        "_keys",
        "_keyPage",
        "_keyPages",
        "_keysSymbol",
        "_keyUp",
        "_keyE",
        "_keysRu",
        "_setCase",
        "_keyboardCharacter",
        "_buildKeyboard",
        "_ottplaylang",
        "_localizedAlphabet",
        "_setLang",
        "_setPunct",
        "showEditKey1",
        "showEdit",
        "renderButtonHint",
    ],
    true
);
const originals = {
    "channels.js": declarations(source("src/channels/index.ts"), [], true),
    "core.js": declarations(source("src/core/index.ts"), [], true),
    "ui.js":
        declarations(source("src/utils/helpers.ts"), [
            "metadataText",
            "metadataImageUrl",
            "metadataCssUrl",
            "metadataHtml",
            "hasTmdbService",
        ]) +
        localization +
        keyboard,
};
const meanings = {
    strDOWN: "▼",
    strFF: "»",
    strLEFT: "◂",
    strNEXT: "▸|",
    strPAUSE: "‖",
    strPLAY: "▸",
    strPlayPause: "▸‖",
    strPREV: "|◂",
    strRETURN: "×",
    strRIGHT: "▸",
    strRW: "«",
    strSTOP: "■",
    strTools: "≡",
    strUP: "▲",
};
const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "ottplay-system-icons-")
);
const full = path.join(temporary, "full");
const play = path.join(temporary, "play");
function treeBytes(directory) {
    const result = {};
    function visit(folder) {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) visit(file);
            else
                result[path.relative(directory, file)] = fs
                    .readFileSync(file)
                    .toString("base64");
        }
    }
    visit(directory);
    return result;
}
function makeStage(directory) {
    fs.mkdirSync(path.join(directory, "fonts"), { recursive: true });
    fs.mkdirSync(path.join(directory, "styles"), { recursive: true });
    fs.copyFileSync(
        path.join(root, "styles/player.css"),
        path.join(directory, "styles/player.css")
    );
    for (const name of fs.readdirSync(path.join(root, "fonts"))) {
        if (/^fontello\./i.test(name) || name === "Gabriela-Regular.ttf")
            fs.copyFileSync(
                path.join(root, "fonts", name),
                path.join(directory, "fonts", name)
            );
    }
    for (const [name, text] of Object.entries(originals))
        fs.writeFileSync(path.join(directory, name), text);
    // Persist controls produced by the real HTML renderer before staging as
    // well as their JS source: both routes must work without the icon font.
    const w = domFixture(originals["ui.js"]);
    try {
        fs.writeFileSync(
            path.join(directory, "controls.html"),
            w.renderButtonHint(w.keys.PLAY, w.strPlayPause, "Play / pause")
        );
    } finally {
        w.close();
    }
}
function domFixture(code = "", css = "") {
    const dom = new JSDOM(
        '<style></style><div id="controls"></div><div id="listEdit" style="width:600px"></div><div id="listPodval"></div>',
        { runScripts: "outside-only", url: "https://localhost/index.html" }
    );
    const w = dom.window;
    require("./helpers/screen-runtime.cjs")(w);
    w.document.querySelector("style").textContent = css;
    w.eval(fs.readFileSync(path.join(root, "js/jquery-1.11.1.min.js"), "utf8"));
    Object.assign(w, {
        _changeEdit() {},
        editCaption: "Playlist URL",
        editvar: "abc",
        keyStrings: {
            no: "Disabled",
            off: "Off",
            "Play / pause": "Play / pause",
            yes: "Enabled",
        },
        keys: {
            BLUE: 13,
            GREEN: 11,
            PLAY: 15,
            RED: 10,
            RETURN: 14,
            YELLOW: 12,
        },
        listFooterElement: w.document.getElementById("listPodval"),
        saveListPanelState() {},
        sNoColorKeys: false,
        stbGetItem: () => "_eng",
    });
    w.eval(code);
    return w;
}
function assertGlyph(w, html, expected) {
    const control = w.document.getElementById("controls");
    control.innerHTML = html;
    assert.equal(control.textContent, expected);
    assert.equal(control.querySelectorAll(".fontello").length, 0);
    for (const element of control.querySelectorAll(".system-icons"))
        assert.equal(w.getComputedStyle(element).fontFamily, "sans-serif");
}
function checkTranslations(w) {
    w.keyStrings = {
        "Found %1": "Found %1 items",
        no: "Disabled",
        off: "Off",
        yes: "Enabled",
    };
    w.useGraphicIcons = false;
    for (const [key, expected] of Object.entries({
        no: "Disabled",
        off: "Off",
        yes: "Enabled",
    }))
        assert.equal(w._(key), expected);
    assert.equal(w._("Found %1", 7), "Found 7 items");
    w.useGraphicIcons = true;
    for (const [key, expected] of Object.entries({
        no: "□",
        off: "□",
        yes: "✓",
    }))
        assertGlyph(w, w._(key), expected);
    w.useGraphicIcons = false;
    assert.equal(
        w._("yes"),
        "Enabled",
        "switching back to text remains supported"
    );
}
function assertNoIconFont(text) {
    assert(
        !/fontello/i.test(text),
        "no icon font names or resource references remain"
    );
    assert(
        !/[\ue000-\uf8ff]/.test(text),
        "no literal private-use glyphs remain"
    );
}

try {
    makeStage(full);
    const before = treeBytes(full);
    assert.equal(
        Object.keys(before).filter((name) => /^fonts\/fontello\./.test(name))
            .length,
        5
    );
    fs.cpSync(full, play, { recursive: true });
    stagePlaySystemIcons(play);
    const css = fs.readFileSync(path.join(play, "styles/player.css"), "utf8");
    test("staging removes all five icon fonts and preserves Full plus unrelated font bytes", () => {
        assert.deepEqual(treeBytes(full), before);
        assert(
            !fs
                .readdirSync(path.join(play, "fonts"))
                .some((name) => /fontello/i.test(name))
        );
        assert.equal(
            fs
                .readFileSync(path.join(play, "fonts/Gabriela-Regular.ttf"))
                .toString("base64"),
            before["fonts/Gabriela-Regular.ttf"]
        );
        for (const name of [
            "styles/player.css",
            "channels.js",
            "core.js",
            "ui.js",
            "controls.html",
        ])
            assertNoIconFont(fs.readFileSync(path.join(play, name), "utf8"));
        assert(
            fs
                .readFileSync(path.join(full, "styles/player.css"), "utf8")
                .includes("fontello.woff2")
        );
    });
    for (const name of ["channels.js", "core.js", "ui.js"]) {
        test(
            "actual " + name + " glyph declarations retain control meaning",
            () => {
                const code = fs.readFileSync(path.join(play, name), "utf8");
                acorn.parse(code, { ecmaVersion: 5 });
                const w = domFixture(code, css);
                try {
                    let checked = 0;
                    for (const [key, expected] of Object.entries(meanings))
                        if (typeof w[key] === "string") {
                            assertGlyph(w, w[key], expected);
                            checked++;
                        }
                    assert(checked > 0);
                    if (name === "core.js") assertGlyph(w, w.strInfo, "i");
                } finally {
                    w.close();
                }
            }
        );
    }
    test("real translation, paired playback buttons and inline OSK retain labels and actions", () => {
        const w = domFixture(
            fs.readFileSync(path.join(play, "ui.js"), "utf8"),
            css
        );
        try {
            checkTranslations(w);
            const controls = w.document.getElementById("controls");
            controls.innerHTML = fs.readFileSync(
                path.join(play, "controls.html"),
                "utf8"
            );
            assert(controls.textContent.includes("▸‖"));
            assert(controls.textContent.includes("Play / pause"));
            let pressed;
            w._doKey = (key) => {
                pressed = key;
            };
            w.document.getElementById("listPodval").appendChild(controls);
            w.eval(declarations(ui, ["uiInit"]));
            w.uiInit();
            assert.equal(
                controls.firstElementChild.getAttribute("onclick"),
                null
            );
            controls.firstElementChild.click();
            assert.equal(
                pressed,
                w.keys.PLAY,
                "paired button dispatches the same media key"
            );
            w.showEditKey1();
            const keyboard = w.document.getElementById("listEdit");
            assert.equal(
                keyboard.querySelector(".osk-cap").textContent,
                "Playlist URL"
            );
            const cells = Array.from(keyboard.querySelectorAll(".osk-key"));
            const language = cells.find((cell) => cell.textContent === "AБ");
            const backspace = cells.find((cell) => cell.textContent === "×");
            assert(
                language && backspace,
                "both inline OSK icon snippets are visible"
            );
            for (const cell of [language, backspace])
                assert.equal(
                    cell.querySelector("[style*='font-family']").style
                        .fontFamily,
                    "sans-serif"
                );
            assert(cells.some((cell) => cell.textContent === "Ok"));
            const footer = w.document.getElementById("listPodval");
            for (const label of ["Close", "Russian", "Delete", "Ok", "▸‖"])
                assert(
                    footer.textContent.includes(label),
                    "OSK footer retains " + label
                );
            w._keysSymbol[1].a();
            assert(
                keyboard.textContent.includes("я"),
                "Lang action still changes to the Cyrillic keyboard"
            );
            assert(
                footer.textContent.includes("English"),
                "return-language label changes with keyboard state"
            );
            assertNoIconFont(w.document.body.innerHTML);
        } finally {
            w.close();
        }
    });
    test("unknown glyph encodings and unexpected font resources fail closed", () => {
        for (const [filename, content, error] of [
            ["future.html", "<span>&#xe899;</span>", /Unmapped Play icon/],
            ["future.js", 'var icon="\\u{e811}";', /Private-use icon remains/],
            [
                "future.css",
                '.future:before { content: "\\e899"; }',
                /Private-use icon remains/,
            ],
            [
                "future.css",
                '.future { background: url("/fonts/fontello.woff2"); }',
                /icon font resource reference/,
            ],
        ]) {
            const stage = path.join(temporary, "negative");
            fs.rmSync(stage, { force: true, recursive: true });
            fs.cpSync(full, stage, { recursive: true });
            fs.writeFileSync(path.join(stage, filename), content);
            assert.throws(() => stagePlaySystemIcons(stage), error);
        }
        assert.deepEqual(
            treeBytes(full),
            before,
            "failed Play staging also leaves its source untouched"
        );
    });

    const bundleArgument = process.argv.indexOf("--bundle");
    if (bundleArgument !== -1) {
        const bundlePath = process.argv[bundleArgument + 1];
        assert(
            bundlePath,
            "--bundle requires a path to the already-built Play classic bundle"
        );
        test("the complete shipped classic bundle exposes system icon globals and translation", () => {
            const bundle = fs.readFileSync(path.resolve(bundlePath), "utf8");
            assertNoIconFont(bundle);
            const globals = new Set();
            function collect(node) {
                if (!node || typeof node !== "object") return;
                if (node.type === "FunctionDeclaration") {
                    globals.add(node.id.name);
                    return;
                }
                if (
                    node.type === "FunctionExpression" ||
                    node.type === "ArrowFunctionExpression"
                )
                    return;
                if (
                    node.type === "VariableDeclarator" &&
                    node.id.type === "Identifier"
                )
                    globals.add(node.id.name);
                for (const child of Object.values(node))
                    if (Array.isArray(child)) child.forEach(collect);
                    else if (child && typeof child === "object") collect(child);
            }
            collect(acorn.parse(bundle, { ecmaVersion: 5 }));
            const smoke = source("tests/test_port_bundle_smoke.cjs");
            const fixture = smoke.statements.find(
                (node) =>
                    ts.isFunctionDeclaration(node) &&
                    node.name?.text === "fixture"
            );
            assert(fixture, "existing full-bundle smoke fixture exists");
            const create = Function(
                "vm",
                "globalNames",
                "return " + fixture.getText(smoke)
            )(vm, globals);
            const actual = create("capacitor-fallback");
            vm.runInContext(bundle, actual, {
                filename: bundlePath,
                timeout: 5000,
            });
            const w = domFixture("", css);
            try {
                for (const [key, expected] of Object.entries(meanings)) {
                    assert.equal(
                        typeof actual[key],
                        "string",
                        "bundle global " + key
                    );
                    assertGlyph(w, actual[key], expected);
                }
                actual.useGraphicIcons = true;
                for (const [key, expected] of Object.entries({
                    no: "□",
                    off: "□",
                    yes: "✓",
                }))
                    assertGlyph(w, actual._(key), expected);
                actual.useGraphicIcons = false;
                actual.keyStrings = { yes: "Enabled" };
                assert.equal(actual._("yes"), "Enabled");
                const controls = w.document.getElementById("controls");
                controls.innerHTML = actual.renderButtonHint(
                    actual.keys.PLAY,
                    actual.strPlayPause,
                    "Play / pause"
                );
                assert(controls.textContent.includes("▸‖"));
                assert(controls.textContent.includes("Play / pause"));
            } finally {
                w.close();
            }
        });
    }
} finally {
    fs.rmSync(temporary, { force: true, recursive: true });
}
console.log("Play system icons: " + cases + " scenarios passed");
