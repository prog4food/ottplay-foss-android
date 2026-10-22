"use strict";
const { fixture } = require("./provider-driver-fixture.cjs");
const { declarations } = require("./playlist-fixture.cjs");
const vm = require("node:vm"),
    ts = require("typescript");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("").window;
module.exports = function (id, options = {}) {
    const f = fixture({
        azkey: "12345678",
        azmpeg: "0",
        kbcv_list: String(options.slot ?? 0),
        ...options.saved,
    });
    const host = f.host,
        events = [],
        panels = {};
    const query = (selector) => {
        const state = (panels[selector] ||= {});
        const chain = {
            append: (value) => {
                events.push(["append", value]);
                return chain;
            },
            hide: () => {
                state.visible = false;
                events.push(["hide"]);
                return chain;
            },
            html: (value) => {
                state.html = value;
                events.push(["html"]);
                return chain;
            },
            show: () => {
                state.visible = true;
                events.push(["show"]);
                return chain;
            },
        };
        return chain;
    };
    query.ajax = f.ajax;
    const oldAlert = host.alert;
    Object.assign(host, {
        $: query,
        aboutKeyHandler: null,
        alert: (value) => {
            oldAlert(value);
            events.push(["alert", value]);
        },
        browserName: () => (options.dune ? "dune" : "browser"),
        DOMParser: dom.DOMParser,
        document: dom.document,
        infoBox: (value) => {
            f.errors.push(value);
            events.push(["info", value]);
        },
        jQuery: {
            parseXML: (text) => {
                const value = new dom.DOMParser().parseFromString(
                    text,
                    "text/xml"
                );
                if (value.querySelector("parsererror"))
                    throw Error("Invalid XML");
                return value;
            },
        },
        keys: { ...host.keys, STOP: 83 },
        location: {
            href: "https://player.test/index.html",
            protocol: "https:",
        },
        mediaName: "Previous catalog",
        mediaRecords: [{ title: "Previous" }],
        mediaUrls: ["parent", "old"],
        navigator: { userAgent: options.agent || "browser" },
        playArchive: (...args) => events.push(["archive", ...args]),
        playChannel: (...args) => events.push(["live", ...args]),
        popupList: () => events.push(["popup"]),
        restart: () => events.push(["restart"]),
        restoreListPanelState: () => events.push(["restore"]),
        saveListPanelState: () => events.push(["save"]),
        sNextCount: -1,
        stb: { getMacAddress: () => options.mac ?? "00:11:22:33:44:55" },
        updateChannelInfo: (id) => events.push(["refresh", id]),
    });
    if (options.intercept)
        host.stbInterceptRequest = (url) => events.push(["intercept", url]);
    vm.runInContext(
        ts.transpileModule(
            declarations("src/provider/drivers.ts")
                .filter((row) =>
                    [
                        "createDriverTransport",
                        "emptyDriverCatalog",
                        "driverCatalogSnapshot",
                    ].includes(row.name)
                )
                .map((row) => row.text)
                .join("\n"),
            { compilerOptions: { target: ts.ScriptTarget.ES5 } }
        ).outputText,
        host
    );
    const driver = f.mount(id);
    function media() {
        return host.__ottMediaCatalog.create(
            {
                core: host.OttPlayCore,
                createLifetime: host.__ottProviderRuntime.createRegistry,
                decodeXml: (text, profile) =>
                    host.__ottCatalogXml.decode(host, text, profile),
                request: (options, done, fail) => {
                    const request = f.ajax(options);
                    request.done(done).fail(fail);
                    return () => request.abort();
                },
                translate: (value) => value,
            },
            f.lifetime.current(),
            { transport: host.createDriverTransport }
        );
    }
    return { ...f, driver, events, media, panels };
};
