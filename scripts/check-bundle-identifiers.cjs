const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");

function checkBundleIdentifiers(code) {
    const ast = acorn.parse(code, { ecmaVersion: 5, sourceType: "script" });
    const bindings = new Set();
    const functions = new Set();
    const publications = new Set();
    const accessors = new Set();
    function isWindow(node) {
        return node?.type === "Identifier" && node.name === "window";
    }
    function propertyName(node) {
        return node.computed ? node.property.value : node.property.name;
    }
    function visit(node) {
        if (!node || typeof node !== "object") return;
        if (node.type === "FunctionDeclaration") {
            bindings.add(node.id.name);
            functions.add(node.id.name);
            return;
        }
        if (node.type === "FunctionExpression") return;
        if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
            bindings.add(node.id.name);
        if (
            node.type === "AssignmentExpression" &&
            node.operator === "=" &&
            node.left.type === "MemberExpression" &&
            isWindow(node.left.object)
        )
            publications.add(propertyName(node.left));
        if (node.type === "CallExpression") {
            if (
                node.callee.type === "Identifier" &&
                node.callee.name === "makeRedefinable" &&
                node.arguments[0]?.type === "Literal"
            )
                accessors.add(node.arguments[0].value);
            if (
                node.callee.type === "MemberExpression" &&
                node.callee.object.type === "Identifier" &&
                node.callee.object.name === "Object" &&
                propertyName(node.callee) === "defineProperty" &&
                isWindow(node.arguments[0]) &&
                node.arguments[1]?.type === "Literal"
            )
                publications.add(node.arguments[1].value);
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === "object") visit(value);
        }
    }
    visit(ast);
    if (functions.has("makeRedefinable"))
        for (const name of accessors) publications.add(name);
    const missing = [
        "startPlayer",
        "popupActions",
        "noProvParam",
        "optionsList",
    ]
        .filter((name) => !bindings.has(name))
        .concat(
            ["listKeyHandler", "chanels"].filter(
                (name) => !publications.has(name) && !bindings.has(name)
            )
        );
    if (missing.length)
        throw new Error(
            "Missing classic global declaration/publication: " +
                missing.join(", ")
        );
}

if (require.main === module) {
    try {
        const file =
            process.argv[2] || path.join(__dirname, "../dist/player.js");
        checkBundleIdentifiers(fs.readFileSync(file, "utf8"));
        console.log(
            "OK: classic ES5 AST retains all 6 required global declarations/publications"
        );
    } catch (error) {
        console.error("error: " + error.message);
        process.exitCode = 1;
    }
}

module.exports = { checkBundleIdentifiers };
