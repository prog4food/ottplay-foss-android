"use strict";
const {
    fixture,
    integrationFixture,
} = require("./provider-driver-fixture.cjs");
function edemFixture(input = {}, integration = false) {
    const saved = {
        ededcdn: "https://cdn.test/path",
        edkey: "12345678",
        edlist: "0",
        edvpurl: "portal::[key:secret]https://portal.test/api",
        ...input,
    };
    const f = integration ? integrationFixture("edem", saved) : fixture(saved);
    const w = f.host,
        events = [],
        panels = {};
    if (integration) panels["#launch"] = { visible: true };
    const ajax = w.$.ajax;
    const query = (selector) => {
        const panel = panels[selector] || (panels[selector] = {});
        const chain = {
            append(value) {
                events.push(["append", value]);
                return chain;
            },
            attr() {
                return chain;
            },
            css() {
                return chain;
            },
            hide() {
                panel.visible = false;
                return chain;
            },
            html(value) {
                panel.html = value;
                return chain;
            },
            is() {
                return !!panel.visible;
            },
            on(name, handler) {
                panel[name] = handler;
                return chain;
            },
            show() {
                panel.visible = true;
                return chain;
            },
        };
        return chain;
    };
    query.ajax = ajax;
    Object.assign(w, {
        _mediaLoadState: {},
        _playMedia: (item) => events.push(["play", item]),
        $: query,
        catIndex: 2,
        closeList() {
            events.push(["close"]);
            if (w.providerMediaClient) w.providerMediaClient.cancel();
            w._mediaLoadState = {};
        },
        curColor: "white",
        curColorB: "blue",
        infoBox: (value) => events.push(["info", value]),
        keys: {
            DOWN: 40,
            ENTER: 13,
            EXIT: 100,
            LEFT: 37,
            N8: 56,
            RETURN: 27,
            RIGHT: 39,
            STOP: 101,
            UP: 38,
        },
        location: {
            href: "https://player.test/index.html",
            protocol: "https:",
            search: "",
        },
        medHistory: [],
        mediaName: "Previous",
        mediaNames: [],
        mediaRecords: [],
        mediaSelects: [0],
        mediaUrls: [],
        playChannel: (...args) => events.push(["live", ...args]),
        primaryIndex: 3,
        selIndex: 3,
        showPage: () => events.push(["render"]),
        sPageSize: 2,
        stbIsPlaying: () => false,
        stbStop: () => events.push(["stop"]),
    });
    return Object.assign(f, { events, panels });
}
module.exports = { edemFixture };
