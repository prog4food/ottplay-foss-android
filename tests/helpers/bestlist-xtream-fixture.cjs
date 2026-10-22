"use strict";
const { context, declarations } = require("./playlist-fixture.cjs"),
    vm = require("node:vm");
exports.run = function (input) {
    const ctx = context(),
        calls = [];
    Object.assign(ctx, {
        _bestlist_stalker_cfg: {
            pass: "x?&",
            server: input.server || "https://xc.test",
            user: "a/b",
        },
        _bestlist_stalker_m3u() {
            calls.push({ m3u: ctx._bestlist_stalker_cfg.m3u });
            ctx.callbacks++;
        },
        launch_id: "#launch",
    });
    ctx.$ = () => ({ append() {} });
    ctx.$.ajax = (request) => {
        calls.push({ url: request.url });
        return {
            done(callback) {
                if (!input.failed) callback(input.account);
                return this;
            },
            fail(callback) {
                if (input.failed) callback();
                return this;
            },
        };
    };
    vm.runInContext(
        declarations("providers/bestlist/stalker/provider.js")
            .filter((row) =>
                [
                    "_bestlist_stalker_xtream",
                    "addChan2cat",
                    "bestlistStalkerCore",
                ].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    ctx._bestlist_stalker_xtream(() => ctx.callbacks++);
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            channels: ctx.chanels,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
};
