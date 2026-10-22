"use strict";
const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm"),
    ts = require("typescript");
const { context, declarations } = require("./playlist-fixture.cjs");
const root = path.resolve(__dirname, "../..");
exports.run = function (profile, input) {
    const ctx = context(),
        calls = [],
        events = [];
    Object.assign(ctx, {
        alert: (m) => events.push(["alert", m]),
        host: "https://relay.test",
        launch_id: "#launch",
    });
    ctx.$ = () => ({ append: (value) => events.push(["append", value]) });
    ctx.$.ajax = (request) => {
        calls.push({
            data: request.data || null,
            dataType: request.dataType,
            method: request.method || "GET",
            timeout: request.timeout,
            url: request.url,
        });
        if (request.method === "post" ? input.proxyFailed : input.directFailed)
            request.error({}, "fixture", "failed");
        else request.success("fixture payload");
    };
    if (input.intercept)
        ctx.stbInterceptRequest = (value) => events.push(["intercept", value]);
    const get = declarations("providers/" + profile + "/provider.js").find(
        (row) => row.name === "getChanelsArray"
    );
    const load = get.node.body.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name.text === "loadPlaylist"
    );
    const adapter = path.join(root, "src/provider/operator.ts");
    if (fs.existsSync(adapter))
        vm.runInContext(
            ts.transpileModule(fs.readFileSync(adapter, "utf8"), {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }).outputText,
            ctx
        );
    vm.runInContext(load.getText(get.source), ctx);
    ctx.loadPlaylist(
        input.url,
        (value) => events.push(["success", value]),
        () => events.push(["complete"])
    );
    return JSON.parse(JSON.stringify({ calls, events }));
};
