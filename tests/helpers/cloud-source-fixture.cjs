const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
function storagePolicySource(bundleAst) {
    const ast =
        bundleAst ||
        ts.createSourceFile(
            "storage.ts",
            fs.readFileSync(
                path.resolve(__dirname, "../../src/storage/index.ts"),
                "utf8"
            ),
            ts.ScriptTarget.Latest,
            true
        );
    const names = ["isStorageMetadataKey", "isPortableSettingsKey"];
    const code = [];
    for (const name of names) {
        const nodes = ast.statements.filter(
            (node) => ts.isFunctionDeclaration(node) && node.name?.text === name
        );
        if (nodes.length !== 1)
            throw Error("Expected one storage policy function: " + name);
        code.push(nodes[0].getText(ast));
    }
    const constants = [];
    for (const statement of ast.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations)
            if (declaration.name.getText(ast) === "STORAGE_FALLBACK_KEYS")
                constants.push("var " + declaration.getText(ast) + ";");
    }
    if (constants.length !== 1)
        throw Error("Expected storage metadata namespace");
    return ts
        .transpileModule(constants.concat(code).join("\n"), {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES5,
            },
        })
        .outputText.replace(/^export /gm, "");
}

function cloudBundleSource(ast) {
    function single(nodes, name) {
        if (nodes.length !== 1)
            throw Error("Expected one bundled cloud dependency: " + name);
        return nodes[0].getText(ast);
    }
    function namedFunction(name) {
        return single(
            ast.statements.filter(
                (node) =>
                    ts.isFunctionDeclaration(node) && node.name?.text === name
            ),
            name
        );
    }
    const expressions = [];
    function split(expression) {
        if (ts.isParenthesizedExpression(expression))
            return split(expression.expression);
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.CommaToken
        ) {
            split(expression.left);
            split(expression.right);
        } else expressions.push(expression);
    }
    for (const statement of ast.statements)
        if (ts.isExpressionStatement(statement)) split(statement.expression);
    function publisher(name) {
        return (
            single(
                expressions.filter((expression) => {
                    let published = false;
                    function visit(node) {
                        if (
                            ts.isBinaryExpression(node) &&
                            node.operatorToken.kind ===
                                ts.SyntaxKind.EqualsToken &&
                            ts.isPropertyAccessExpression(node.left) &&
                            ts.isIdentifier(node.left.expression) &&
                            node.left.expression.text === "window" &&
                            node.left.name.text === name
                        )
                            published = true;
                        ts.forEachChild(node, visit);
                    }
                    visit(expression);
                    return published;
                }),
                name
            ) + ";"
        );
    }
    const bridges = [];
    for (const statement of ast.statements)
        if (ts.isVariableStatement(statement))
            for (const declaration of statement.declarationList.declarations)
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "cloudSettingsTransfer"
                )
                    bridges.push(declaration);
    return [
        storagePolicySource(ast),
        namedFunction("metadataText"),
        namedFunction("settingsFailure"),
        namedFunction("commitSettingsWrites"),
        publisher("__ottSourceIdentity"),
        publisher("__ottCloudSettingsCodec"),
        "var " + single(bridges, "cloudSettingsTransfer") + ";",
        namedFunction("cloudSendSettings"),
        namedFunction("cloudLoadSettings"),
    ].join("\n");
}
function cloudSource(bundleAst) {
    // A supplied artifact must be complete. Never fall back to TypeScript in bundle tests.
    if (bundleAst) return cloudBundleSource(bundleAst);
    const root = path.resolve(__dirname, "../..");
    const source = [
        "src/provider/source-identity.ts",
        "src/settings/store.ts",
        "src/settings/cloud-codec.ts",
        "src/settings/cloud.ts",
    ]
        .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
        .join("\n");
    const helpers = fs.readFileSync(
        path.join(root, "src/utils/helpers.ts"),
        "utf8"
    );
    const ast = ts.createSourceFile(
        "helpers.ts",
        helpers,
        ts.ScriptTarget.Latest,
        true
    );
    const escape = ast.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === "metadataText"
    );
    return ts
        .transpileModule(
            storagePolicySource() + "\n" + escape.getText(ast) + "\n" + source,
            {
                compilerOptions: {
                    module: ts.ModuleKind.ES2015,
                    target: ts.ScriptTarget.ES5,
                },
            }
        )
        .outputText.replace(/^import .*$/gm, "")
        .replace(/^export /gm, "");
}
module.exports = { cloudSource, storagePolicySource };
