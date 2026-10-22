const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../..");
const files = ["unicode-data", "unicode", "assets", "index"].map(
    (name) => "src/localization/" + name + ".ts"
);
function parse(file) {
    return ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
}
function compile(text) {
    return ts.transpileModule(text, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}
function localizationRuntime(bundle) {
    if (!bundle)
        return files
            .map((file) => {
                const ast = parse(file);
                return compile(
                    ast.statements
                        .filter(
                            (node) =>
                                !ts.isImportDeclaration(node) &&
                                !ts.isExportDeclaration(node)
                        )
                        .map((node) =>
                            node.getText(ast).replace(/^export\s+/, "")
                        )
                        .join("\n")
                );
            })
            .join("\n");
    const names = new Set();
    files.forEach((file) =>
        parse(file).statements.forEach((node) => {
            if (ts.isFunctionDeclaration(node) && node.body)
                names.add(node.name.text);
            if (ts.isVariableStatement(node))
                node.declarationList.declarations.forEach((item) =>
                    names.add(item.name.getText())
                );
        })
    );
    const ast = parse(bundle),
        code = [],
        found = new Set();
    ast.statements.forEach((node) => {
        if (ts.isFunctionDeclaration(node) && names.has(node.name.text)) {
            code.push(node.getText(ast));
            found.add(node.name.text);
        }
        if (ts.isVariableStatement(node))
            node.declarationList.declarations.forEach((item) => {
                if (names.has(item.name.getText(ast))) {
                    code.push("var " + item.getText(ast) + ";");
                    found.add(item.name.getText(ast));
                }
            });
        if (
            ts.isExpressionStatement(node) &&
            /^Object\.keys\(languageMetadata\)\.forEach\(/.test(
                node.getText(ast)
            )
        )
            code.push(node.getText(ast));
    });
    for (const name of names)
        if (!found.has(name))
            throw new Error("Missing bundled localization declaration " + name);
    return compile(code.join("\n"));
}
module.exports = { localizationRuntime };
