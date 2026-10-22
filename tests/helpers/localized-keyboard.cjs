const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { localizationRuntime } = require("./localization-runtime.cjs");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function declarations(file, names) {
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const found = new Set();
    const code = [];
    for (const node of ast.statements) {
        if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
            code.push(node.getText(ast).replace(/^export\s+/, ""));
            found.add(node.name.text);
        }
        if (ts.isVariableStatement(node)) {
            for (const item of node.declarationList.declarations) {
                if (names.includes(item.name.getText(ast))) {
                    code.push("var " + item.getText(ast) + ";");
                    found.add(item.name.getText(ast));
                }
            }
        }
    }
    for (const name of names)
        if (!found.has(name))
            throw new Error("Missing production declaration " + name);
    return ts.transpileModule(code.join("\n"), {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
const keyboardNames = [
    "_keys1",
    "_keysA",
    "_keysL",
    "_keysP",
    "_keys",
    "_keysRu",
    "_keysSymbol",
    "_keyCur",
    "_keyP",
    "_keyUp",
    "_keyE",
    "_keyPage",
    "_keyPages",
    "cursorInterval",
    "_setCase",
    "_keyboardCharacter",
    "_ottplaylang",
    "_localizedAlphabet",
    "_setLang",
    "_buildKeyboard",
    "_setPunct",
    "showEditKey1",
    "showEdit",
    "_changeEdit",
    "clickKey",
    "editKey1",
    "renderButtonHint",
    "strRETURN",
    "strTools",
    "strFF",
    "strRW",
    "strPlayPause",
];
function keyboardCode(bundle) {
    if (bundle)
        return (
            localizationRuntime(bundle) +
            declarations(bundle, [
                "metadataText",
                "metadataHtml",
                "metadataCssUrl",
                "metadataImageUrl",
                ...keyboardNames.map((name) =>
                    name === "renderButtonHint" ? "btnDiv" : name
                ),
            ])
        );
    return (
        declarations("src/utils/helpers.ts", [
            "metadataText",
            "metadataHtml",
            "metadataCssUrl",
            "metadataImageUrl",
        ]) +
        localizationRuntime() +
        declarations("src/ui/index.ts", keyboardNames)
    );
}
function initializeKeyboard() {
    window.keys = {
        BLUE: 406,
        DOWN: 40,
        ENTER: 13,
        EXIT: 8,
        FF: 417,
        GREEN: 404,
        LEFT: 37,
        PAUSE: 19,
        PLAY: 415,
        RED: 403,
        RETURN: 27,
        RIGHT: 39,
        RW: 412,
        TOOLS: 457,
        UP: 38,
        YELLOW: 405,
    };
    window.ott_device = "tizen";
    window.editvar = "";
    window.editPos = 0;
    window.editCaption = "Search";
    window.curColor = "white";
    window.curColorB = "navy";
    window.sNoColorKeys = true;
    window.saveListPanelState = function () {};
    window.saveCPD = window.saveListPanelState;
    window.restoreListPanelState = function () {};
    window.__ottClassicScreenPort = {
        finishEditor: function (_save, done) {
            done();
        },
        openEditor: function () {
            return {
                active: function () {
                    return true;
                },
            };
        },
        owner: function () {
            return null;
        },
    };
    window.listFooterElement = document.getElementById("listPodval");
    window.listPodvalElement = window.listFooterElement;
    window.stbGetItem = function () {
        return window.fixtureLocale;
    };
}
module.exports = { declarations, initializeKeyboard, keyboardCode, read, root };
