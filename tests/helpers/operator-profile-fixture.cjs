"use strict";
const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm"),
    ts = require("typescript"),
    cp = require("node:child_process");
const { context } = require("./playlist-fixture.cjs");
const root = path.resolve(__dirname, "../..");
exports.run = function (profile, input, baseline) {
    const file = "providers/" + profile + "/provider.js";
    const source = baseline
        ? cp.execFileSync("git", ["show", baseline + ":" + file], {
              cwd: root,
              encoding: "utf8",
          })
        : fs.readFileSync(path.join(root, file), "utf8");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const ctx = context(),
        calls = [],
        events = [],
        writes = [];
    const settings = {
        edcdn: "https://cdn.test/path",
        id: "fixture-id",
        key: "12345678",
        list: "1",
        login: "12345678",
        pass: "abcdefgh",
        pin: "fixture-pin",
        server: "2",
        token: "1234567890",
        www: "https://tv.team/pl/11/token/playlist.m3u8",
        ...input.settings,
    };
    Object.assign(ctx, {
        alert: (value) => events.push(["alert", value]),
        box_mac: input.mac === undefined ? "00:11:22:33:44:55" : input.mac,
        browserName: () => (input.dune ? "dune" : "fixture"),
        btnDiv: () => "button",
        epg: {},
        host: "https://relay.test",
        infoBox: (value) => events.push(["info", value]),
        keys: { ENTER: 13 },
        launch_id: "#launch",
        noProvParam() {},
        popupActions: [],
        popupList() {
            events.push(["settings"]);
        },
        providerGetItem: (key) => settings[key],
        providerSetItem: (key, value) => {
            settings[key] = value;
            writes.push([key, value]);
        },
        strENTER: "Enter",
        url_srv: "http://list.1ott.net",
        v_list: input.list === undefined ? 0 : input.list,
    });
    ctx.location = {
        href: input.href || "https://player.test/index.html",
        protocol: "https:",
    };
    ctx.$ = () => ({
        append: (value) => events.push(["append", value]),
        val() {},
    });
    if (input.intercept)
        ctx.stbInterceptRequest = (url) => events.push(["intercept", url]);
    ctx.$.ajax = (request) => {
        const index = calls.length;
        calls.push({
            data: request.data || null,
            dataType: request.dataType,
            method: request.method || "GET",
            timeout: request.timeout,
            url: request.url,
        });
        if (input.failAll || (input.failFirst && index === 0))
            request.error({}, "fixture", "failed");
        else {
            let data = "#EXTM3U\n";
            const original = (request.data && request.data.url) || request.url;
            if (profile === "1ott" && original.includes("/PinApi/"))
                data =
                    input.auth === undefined
                        ? ' {"token":"fixture-token"} '
                        : input.auth;
            if (profile === "shura" && request.dataType === "jsonp")
                data = input.channels === undefined ? [] : input.channels;
            request.success(data);
        }
        if (request.complete) request.complete();
    };
    if (!baseline) require("./operator-fixture-host.cjs")(ctx);
    vm.runInContext(
        ast.statements
            .filter(ts.isFunctionDeclaration)
            .map((n) => n.getText(ast))
            .join("\n"),
        ctx
    );
    ctx.doEditData = () => events.push(["edit"]);
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
            events,
            failure,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            href: ctx.location.href,
            ids: ctx.cList,
            writes,
        })
    );
};
