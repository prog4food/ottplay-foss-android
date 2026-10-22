"use strict";
const fs = require("node:fs"),
    vm = require("node:vm"),
    ts = require("typescript");
const { context } = require("./playlist-fixture.cjs");
exports.run = function (input) {
    const ctx = context(),
        calls = [],
        events = [];
    const source = ts.createSourceFile(
        "edem",
        fs.readFileSync("providers/edem/provider.js", "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    Object.assign(ctx, {
        _playMedia(med) {
            events.push(["play", med]);
        },
        _vpkey: "existing",
        _vpurl: "https://portal.test/api",
        alert(value) {
            events.push([
                "alert",
                value instanceof Error
                    ? { message: value.message, name: value.name }
                    : String(value),
            ]);
        },
        closeList() {
            events.push(["closeList"]);
        },
        medHistory: [],
        mediaName: "Previous",
        mediaRecords: [{ title: "previous" }],
        mediaUrls: ["root"],
        playType: 0,
        provName: "ED",
        selIndex: 3,
        showPage() {
            events.push(["showPage"]);
        },
        sPageSize: 2,
        vpurl: "portal::[key:secret]https://portal.test/api",
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
            async: request.async,
            data: request.data,
            type: request.type,
            url: request.url,
        });
        if (input.fail) {
            if (request.error) request.error({ status: 500 });
        } else
            request.success(
                JSON.parse(
                    JSON.stringify(
                        input.response === undefined ? null : input.response
                    )
                )
            );
        if (request.complete) request.complete();
    };
    require("./operator-fixture-host.cjs")(ctx);
    const statements = source.statements.filter(
        (s) =>
            ts.isFunctionDeclaration(s) ||
            (ts.isVariableStatement(s) &&
                s.declarationList.declarations.some(
                    (d) => d.name.text === "_getMediaArray"
                ))
    );
    vm.runInContext(statements.map((s) => s.getText(source)).join("\n"), ctx);
    ctx.getMediaArray = ctx._getMediaArray;
    ctx.selectVariant = (index, values, callback) => {
        events.push(["variants", index, values]);
        callback(input.variant === undefined ? 0 : input.variant);
    };
    const callback = () => ctx.callbacks++;
    if (input.stale) callback.isCurrent = () => false;
    let value,
        failure = null;
    try {
        if (input.method === "media")
            value = ctx.createMedia(input.item, input.parent);
        else if (input.method === "page")
            value = ctx.addMedias2(
                input.params || { app: "ott-play", key: "existing", limit: 2 }
            );
        else if (input.method === "play") ctx.edem_playMedia(input.item);
        else
            ctx._getMediaArray(
                input.url === undefined ? "" : input.url,
                callback
            );
    } catch (error) {
        failure = { message: error.message, name: error.name };
    }
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            calls,
            events,
            failure,
            item: input.item,
            mediaName: ctx.mediaName,
            mediaRecords: ctx.mediaRecords,
            selIndex: ctx.selIndex,
            value,
            vpkey: ctx._vpkey,
            vpurl: ctx._vpurl,
        })
    );
};
