"use strict";
const { context, declarations } = require("./playlist-fixture.cjs"),
    vm = require("node:vm");
exports.run = function (input) {
    const ctx = context(),
        calls = [];
    Object.assign(ctx, {
        alert: (value) => ctx.errors.push(value),
        checkProviderUrl: () => true,
        Date: { now: () => 1767225600500 },
        editStalkerSettings: () => calls.push({ settings: true }),
        launch_id: "#launch",
        loadStalkerParams() {},
        stalker: input.config || {
            mac: "00:1a:79:01:02:03",
            portal: "https://portal.test/",
        },
    });
    ctx.$ = () => ({ append() {} });
    ctx.$.ajax = (request) => {
        const reply = input.responses[calls.length];
        calls.push({
            data: JSON.parse(request.data),
            method: request.type,
            timeout: request.timeout,
            url: request.url,
        });
        if (calls.length > 15) throw Error("Fixture request overflow");
        return {
            done(callback) {
                callback(reply);
                return this;
            },
            fail() {
                return this;
            },
        };
    };
    vm.runInContext(
        declarations("providers/stalker/provider.js")
            .filter((row) =>
                [
                    "getChanelsArray",
                    "loadChannelsFromStalker",
                    "stalkerApiCall",
                    "addChan2cat",
                    "getEPGchanel",
                    "stalkerCore",
                ].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    let epg;
    ctx.getChanelsArray(() => ctx.callbacks++);
    if (input.guide && ctx.cList.length)
        ctx.getEPGchanel(ctx.cList[0], (id, data) => {
            epg = { data, id };
        });
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            channels: ctx.chanels,
            epg,
            errors: ctx.errors,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
};
