"use strict";
const vm = require("node:vm");
const { context, declarations } = require("./playlist-fixture.cjs");
exports.run = function (provider, input) {
    const ctx = context(),
        calls = [],
        errors = [];
    Object.assign(ctx, {
        alert: (value) => errors.push(value),
        epg: { retained: [{ name: "retained" }] },
        infoBox: (value) => errors.push(value),
        noProvParam() {},
        popupActions: [],
        popupList() {},
        providerGetItem: (key) =>
            ({
                key: "1234567890",
                mpeg: "0",
                ottkey: "12345678",
                ottwww: "operator.test",
                ...input.settings,
            })[key],
        wwwapi: "http://api.fixture/",
    });
    ctx.$ = () => ({ val() {} });
    ctx.$.ajax = (request) => {
        calls.push({
            dataType: request.dataType,
            timeout: request.timeout,
            url: request.url,
        });
        if (input.networkFailed) request.error({}, "fixture", "failure");
        else request.success(input.data);
        request.complete();
    };
    vm.runInContext(
        declarations("providers/" + provider + "/provider.js")
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
            epg: ctx.epg,
            errors,
            failure,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
};
