const vm = require("node:vm");
const cp = require("node:child_process");
const ts = require("typescript");
const { context, declarations } = require("./playlist-fixture.cjs");
exports.run = function (profile, input, baseline) {
    const channelId = input.id === undefined ? "c" : input.id;
    const ctx = context(),
        calls = [],
        events = [];
    Object.assign(ctx, {
        __hls: input.hls || 0,
        _epgDomen: "https://epg.test/",
        chanels: {
            c: Object.assign(
                {
                    rec: input.rec === undefined ? 0 : input.rec,
                    server: "af.test",
                    server_cdn: "itv.test",
                    token: "token",
                    url: "https://localhost/00000000000000/index.m3u8?foo=1",
                },
                input.channel || {}
            ),
        },
        edcdn: input.host === undefined ? "https://cdn.test/path" : input.host,
        edkey: "ed-key",
        itvmpeg: input.mode === undefined ? 0 : input.mode,
        mpeg: input.mode === undefined ? 0 : input.mode,
        ottkey: "club-key",
        ottwww: "club.test",
        shkey: "sh-key",
        shserver: "2",
        sNextCount: input.next === undefined ? -1 : input.next,
        ts_hls: input.mode === undefined ? 0 : input.mode,
        wwwapi: "https://itv.test/",
    });
    ctx.$ = {
        ajax(request) {
            calls.push({
                dataType: request.dataType,
                timeout: request.timeout,
                url: request.url,
            });
            const index = calls.length - 1;
            const data = input.responses ? input.responses[index] : null;
            if (data !== undefined && request.success)
                request.success(JSON.parse(JSON.stringify(data)));
            if (request.complete) request.complete();
        },
    };
    require("./operator-fixture-host.cjs")(ctx);
    let functions;
    if (baseline) {
        const text = cp.execFileSync(
            "git",
            ["show", "HEAD:providers/" + profile + "/provider.js"],
            { encoding: "utf8" }
        );
        const tree = ts.createSourceFile(
            "provider",
            text,
            ts.ScriptTarget.Latest,
            true
        );
        functions = tree.statements
            .filter(ts.isFunctionDeclaration)
            .map((row) => row.getText(tree));
    } else
        functions = declarations("providers/" + profile + "/provider.js").map(
            (row) => row.text
        );
    vm.runInContext(functions.join("\n"), ctx);
    ctx.chanels[channelId] = ctx.chanels.c;
    ctx._getParams = function () {};
    ctx.getEPGurl = () => input.epgUrl || "";
    let value,
        failure = null;
    try {
        if (input.method === "epg")
            ctx[input.current ? "getEPGchanelCur" : "getEPGchanel"](
                channelId,
                (id, data) => {
                    events.push([id, data]);
                }
            );
        else value = ctx.getChannelUrl(channelId);
    } catch (error) {
        failure = { message: error.message, name: error.name };
    }
    return JSON.parse(JSON.stringify({ calls, events, failure, value }));
};
