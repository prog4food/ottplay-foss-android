"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const core = fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8");
const contracts = require("./fixtures/archive/providers.json");
const functions = new Map();
for (const row of contracts.fixtures) {
    if (!functions.has(row.provider)) {
        const source = ts.createSourceFile(
            "provider.js",
            fs.readFileSync(
                path.join(root, "providers", row.provider, "provider.js"),
                "utf8"
            ),
            ts.ScriptTarget.Latest,
            true
        );
        const declaration = source.statements.find(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                node.name?.text === "getArchiveUrl"
        );
        const body = declaration.getText(source);
        assert(
            !/\.replace\(|Math\.floor|timeshift_abs|archive_end/.test(body),
            "Provider contains displaced archive decisions: " + row.provider
        );
        functions.set(row.provider, body);
    }
    const context = vm.createContext({
        __hls: 0,
        _getParams: () => {},
        browserName: () => (row.dune ? "dune" : "pc"),
        chanels: { 42: row.channel },
        getChannelUrl: () => row.channel.url,
        getServ: () => "cdn.test",
        itvmpeg: row.variant,
        mpeg: row.variant,
        ts_hls: row.variant,
    });
    vm.runInContext(core, context);
    // Keep the engine's complete Date API; only the host clock is fixed.
    context.clock = row.now * 1000;
    vm.runInContext("Date.now = function () { return clock; };", context);
    vm.runInContext(functions.get(row.provider), context);
    assert.equal(
        context.getArchiveUrl("42", row.start, row.end),
        row.expected,
        row.provider +
            ": " +
            JSON.stringify({
                dune: row.dune,
                end: row.end,
                mode: row.channel.ca,
                start: row.start,
                variant: row.variant,
            })
    );
}
console.log(
    "PASS " +
        contracts.fixtures.length +
        " recorded archive contracts across " +
        functions.size +
        " provider adapters using the compiled common core"
);
