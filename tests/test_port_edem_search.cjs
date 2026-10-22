/* Exercise the shipped VPortal parser: HTTP query encoding must not reach its JSON API. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(
    path.join(__dirname, "../providers/edem/provider.js"),
    "utf8"
);
const ast = ts.createSourceFile(
    "provider.js",
    source,
    ts.ScriptTarget.Latest,
    true
);
const declaration = ast.statements.find(
    (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
            (entry) => entry.name.getText(ast) === "_getMediaArray"
        )
);
assert(declaration, "The real Edem VPortal parser must exist");

function parseSearch(query) {
    let request;
    let completed = false;
    const context = {
        _: (text) => text,
        _vpkey: "fixture-key",
        _vpurl: "https://example.invalid/vportal",
        $() {
            return {
                hide() {
                    return this;
                },
                html() {
                    return this;
                },
                show() {
                    return this;
                },
            };
        },
        host: "",
        mediaName: "",
        mediaRecords: [],
        sPageSize: 30,
    };
    context.$.ajax = (options) => {
        request = JSON.parse(options.data);
        assert.equal(options.type, "post");
        assert.equal(request.cmd, "search");
        options.success({ items: [], type: "category" });
        options.complete();
    };
    vm.createContext(context);
    context.OttPlayCore = require("./helpers/shared-core-runtime.cjs")(context);
    vm.runInContext(declaration.getText(ast), context);
    context._getMediaArray("search?search=" + query, () => {
        completed = true;
    });
    assert(completed, "Search must complete even with malformed escapes");
    return { query: request.query, title: context.mediaName };
}

for (const text of [
    "Игра престолов",
    "Star Wars",
    "a=b & c+d",
    "100% and a literal %20",
]) {
    const result = parseSearch(encodeURIComponent(text));
    assert.equal(result.query, text, "JSON search must use the original text");
    assert.equal(result.title, "[" + text + "]");
}
for (const text of ["100%", "%D0%", "%ZZ + = &"]) {
    assert.equal(
        parseSearch(text).query,
        text,
        "Malformed legacy queries must remain usable without throwing"
    );
}

console.log("PASS Edem VPortal search decoding (7 cases)");
