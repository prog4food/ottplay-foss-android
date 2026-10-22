"use strict";
const { context, declarations } = require("./playlist-fixture.cjs");
function run(input) {
    const ctx = context(),
        calls = [];
    const config = input.config || {
        password: "x?&",
        server: "https://xc.test/folder",
        username: "a/b",
    };
    Object.assign(ctx, {
        alert: (value) => ctx.errors.push(value),
        checkProviderUrl: () => true,
        editXtreamSettings: () => calls.push("settings"),
        launch_id: "#launch",
        loadXtreamParams() {},
        xtream: config,
    });
    ctx.$ = () => ({ append() {} });
    ctx.$.ajax = (request) => {
        calls.push(request.url);
        return {
            done(callback) {
                callback(input.account);
                return this;
            },
            fail() {
                return this;
            },
        };
    };
    const vm = require("node:vm");
    vm.runInContext(
        declarations("providers/xtream/provider.js")
            .filter((row) =>
                ["getChanelsArray", "xtreamCore"].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    ctx.getChanelsArray(() => ctx.callbacks++);
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            channels: ctx.chanels,
            errors: ctx.errors,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
}
module.exports = { run };
function guide(input) {
    const ctx = context(),
        calls = [];
    Object.assign(ctx, {
        chanels: { channel: { epg: "42" } },
        loadXtreamParams() {},
        xtream: { password: "x?&", server: "https://xc.test", username: "a/b" },
    });
    ctx.$ = {
        ajax(request) {
            calls.push(request.url);
            return {
                done(callback) {
                    callback(input);
                    return this;
                },
                fail() {
                    return this;
                },
            };
        },
    };
    const vm = require("node:vm");
    vm.runInContext(
        declarations("providers/xtream/provider.js")
            .filter((row) => ["getEPGchanel", "xtreamCore"].includes(row.name))
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    let output;
    ctx.getEPGchanel("channel", (id, data) => {
        output = { data, id };
    });
    return JSON.parse(JSON.stringify({ calls, output }));
}
module.exports.guide = guide;
