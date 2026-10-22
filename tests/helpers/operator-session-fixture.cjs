"use strict";
const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm");
const { context, declarations } = require("./playlist-fixture.cjs");
const root = path.resolve(__dirname, "../..");
const inventory = [];
function scan(directory) {
    for (const row of fs.readdirSync(path.join(root, directory), {
        withFileTypes: true,
    })) {
        const file = directory + "/" + row.name;
        if (row.isDirectory()) scan(file);
        else if (row.name === "provider.js") {
            const source = fs.readFileSync(path.join(root, file), "utf8");
            const match = /function (_\w+)_xtream\(/.exec(source);
            if (match && !source.includes("legacyXtreamClient"))
                inventory.push({ file, prefix: match[1] });
        }
    }
}
scan("providers");
exports.providers = inventory;
exports.run = function (provider, input) {
    const ctx = context(),
        calls = [],
        errors = [];
    const config = input.config || {
        m3u: "https://operator.test/fallback.m3u",
        pass: "x?&",
        server: "https://operator.test/base",
        user: "a/b",
    };
    Object.assign(ctx, {
        alert: (message) => errors.push(message),
        host: "https://relay.test",
        launch_id: "#launch",
        providerGetItem: () => JSON.stringify(config),
    });
    ctx[provider.prefix + "_cfg"] = {};
    ctx.$ = () => ({ append() {} });
    ctx.$.ajax = (request) => {
        calls.push({
            data: request.data || null,
            dataType: request.dataType || null,
            method: request.method || request.type || "GET",
            timeout: request.timeout,
            url: request.url,
        });
        if (request.dataType === "json")
            return {
                done(callback) {
                    if (!input.apiFailed) callback(input.account);
                    return this;
                },
                fail(callback) {
                    if (input.apiFailed) callback();
                    return this;
                },
            };
        if (
            request.method === "post" ? input.proxyFailed : input.playlistFailed
        )
            request.error();
        else
            request.success(
                input.playlist ||
                    '#EXTM3U\n#EXTINF:-1 tvg-id="m" group-title="Playlist",Fallback\nhttps://stream.test/m\n'
            );
    };
    require("./operator-fixture-host.cjs")(ctx);
    vm.runInContext(
        declarations(provider.file)
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    let failure = null;
    try {
        ctx.getChanelsArray(() => ctx.callbacks++);
    } catch (error) {
        failure = { message: error.message, name: error.name };
    }
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            channels: ctx.chanels,
            config: ctx[provider.prefix + "_cfg"],
            errors,
            failure,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
};
