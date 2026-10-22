"use strict";
const vm = require("node:vm"),
    { JSDOM } = require("jsdom");
const { context, declarations } = require("./playlist-fixture.cjs");
exports.run = function (profile, input, translate = (value) => value) {
    const ctx = context(),
        calls = [],
        events = [];
    const window = new JSDOM("").window;
    Object.assign(ctx, {
        _: translate,
        alert: (value) => events.push(["alert", value]),
        box_mac: input.mac === undefined ? "00:11:22:33:44:55" : input.mac,
        mediaName: "Previous catalog",
        mediaRecords: [{ title: "Previous" }],
        mediaUrls: ["parent", "old"],
    });
    ctx.$ = () => ({
        hide() {
            events.push(["hide"]);
            return this;
        },
        html() {
            events.push(["html"]);
            return this;
        },
        show() {
            events.push(["show"]);
            return this;
        },
    });
    ctx.$.ajax = (request) => {
        calls.push({
            dataType: request.dataType,
            timeout: request.timeout,
            url: request.url,
        });
        if (!input.failed) request.success(input.data);
        request.complete();
    };
    ctx.jQuery = {
        parseXML: (value) => {
            const parsed = new window.DOMParser().parseFromString(
                value,
                "text/xml"
            );
            if (parsed.querySelector("parsererror"))
                throw new Error("XML parser error");
            return parsed;
        },
    };
    require("./operator-fixture-host.cjs")(ctx);
    vm.runInContext(
        declarations("providers/" + profile + "/provider.js")
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    const callback = () => ctx.callbacks++;
    if (input.stale) callback.isCurrent = () => false;
    let failure = null;
    try {
        ctx.getMediaArrayXML(
            input.url === undefined ? "https://vod.test/catalog" : input.url,
            callback
        );
    } catch (error) {
        failure = { message: error.message, name: error.name };
    }
    const result = JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            events,
            failure,
            mediaName: ctx.mediaName,
            mediaRecords: ctx.mediaRecords,
            mediaUrls: ctx.mediaUrls,
        })
    );
    window.close();
    return result;
};
