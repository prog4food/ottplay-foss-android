const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const {
    fixture,
    integrationFixture,
} = require("./provider-driver-fixture.cjs");
const root = path.resolve(__dirname, "../..");

module.exports = function m3uFixture(options = {}) {
    const initial = {
        m3um3uArr: JSON.stringify(
            options.config || {
                active: 0,
                M3Us: [
                    { rechours: "48", www: "https://playlist.test/list.m3u" },
                ],
            }
        ),
        ...options.storage,
    };
    const f = options.integration
        ? integrationFixture("m3u", initial)
        : fixture(initial);
    const host = f.host,
        events = [],
        forms = {},
        panels = {},
        timers = new Map();
    const dom = new JSDOM(
        "<!doctype html><video id='video'></video><div id='dialogbox'></div>"
    );
    let timer = 0;
    const ajax = f.ajax;
    function query(selector) {
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
            filter(value) {
                forms.radio = value;
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
                return true;
            },
            on() {
                return chain;
            },
            prop(key, value) {
                forms[key] = value;
                return chain;
            },
            show() {
                panel.visible = true;
                return chain;
            },
            val(value) {
                if (arguments.length) forms[selector] = value;
                return forms[selector];
            },
        };
        return chain;
    }
    // The actual VPortal client uses jQuery's option callbacks; domain drivers use Deferred methods.
    query.ajax = function (options) {
        const request = ajax(options),
            resolve = request.resolve,
            reject = request.reject,
            abort = request.abort;
        let closed = false;
        request.resolve = function (value) {
            if (options.success) options.success(value, "success", request);
            else resolve.call(request, value);
            if (options.complete) options.complete();
            closed = true;
        };
        request.reject = function (...args) {
            if (options.error) options.error(...args);
            else reject.apply(request, args);
            if (options.complete) options.complete();
            closed = true;
        };
        request.abort = function () {
            if (options.error || options.complete) {
                request.aborts++;
                if (!closed) request.reject({}, "abort", "abort");
            } else abort.call(request);
        };
        return request;
    };
    Object.assign(host, {
        __ottClassicPlayback: {
            cancel() {},
            suspendPersistence: () => events.push(["suspend-journal"]),
        },
        _playMedia: (value) => events.push(["play", value]),
        $: query,
        browserName: () => (options.dune ? "dune" : "browser"),
        cancelMediaLoad() {
            if (host.providerMediaClient) host.providerMediaClient.cancel();
            events.push(["cancel-media"]);
        },
        clearBootHide: () => events.push(["clear-boot"]),
        clearTimeout(id) {
            timers.delete(id);
        },
        client_can: { crossxhr: options.crossOrigin !== false },
        curColor: "white",
        curList: [],
        DOMParser: dom.window.DOMParser,
        document: dom.window.document,
        getCurProgData: (id, callback) => {
            events.push(["refresh", id]);
            callback(id);
        },
        getMediaArray: null,
        jQuery: query,
        location: {
            host: "player.test",
            href: options.href || "https://player.test/index.html",
            search: "",
        },
        medFavorites: [],
        medHistory: [],
        mediaName: "",
        mediaNames: [],
        mediaRecords: [],
        mediaRecordsPar: null,
        mediaSelects: [0],
        mediaUrls: null,
        navigator: { userAgent: "browser" },
        pdsa: [
            "prevArr",
            "medHistory",
            "medFavorites",
            "playbackJournal",
            "continueWatch",
            "catIndex",
            "primaryIndex",
        ],
        popupList: (...args) => events.push(["popup", ...args]),
        primaryIndex: 0,
        providerMediaClient: null,
        setTimeout(callback) {
            const id = ++timer;
            timers.set(id, callback);
            return id;
        },
        showFileDialog: (value, extensions) =>
            events.push(["file", value, extensions]),
        sNoNumbersKeys: false,
        sPageSize: 30,
        stb: { getMacAddress: () => "00:11:22:33:44:55" },
        strENTER: "Enter",
        strNew: "",
        strRETURN: "Return",
        updateChannelInfo: (id) => events.push(["info", id]),
        updateChannelListRow: (id) => events.push(["row", id]),
    });
    if (options.native) host.Capacitor = {};
    if (options.readFile) host.readFile = options.readFile;
    if (options.intercept) host.stbInterceptRequest = options.intercept;
    host.playMedia = host._playMedia;
    const helperSource = fs.readFileSync(
        path.join(root, "src/utils/helpers.ts"),
        "utf8"
    );
    const ast = ts.createSourceFile(
        "helpers.ts",
        helperSource,
        ts.ScriptTarget.Latest,
        true
    );
    const helpers = ast.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) &&
                ["metadataText", "metadataImageUrl"].includes(node.name?.text)
        )
        .map((node) => node.getText(ast).replace(/^export /, ""))
        .join("\n");
    const portal = fs
        .readFileSync(path.join(root, "src/plugins/vportal.ts"), "utf8")
        .replace(/^import[^;]+;\s*/gm, "")
        .replace(/^export\s+/gm, "");
    vm.runInContext(
        ts.transpileModule(helpers + "\n" + portal, {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }).outputText,
        host
    );
    return {
        ...f,
        get completed() {
            return f.completed;
        },
        dom,
        events,
        forms,
        panels,
        get reloads() {
            return f.reloads;
        },
        start() {
            if (options.integration) {
                host.loadProv();
                return host.__ottActiveProviderDriver;
            }
            return f.mount("m3u");
        },
        timers,
    };
};
