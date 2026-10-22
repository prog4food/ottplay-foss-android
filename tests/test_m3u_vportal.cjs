const {
    attachSourceAliases,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
/* Legacy portal values remain inert in M3U while TV and Dune catalogs work. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const bundled = process.argv.includes("--bundle");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const adapter = read("providers/m3u/provider.js");
const portal = "portal::[key:FIXTURE_PRIVATE_KEY]http://portal.invalid/api/v1/";
const otherPortal =
    "portal::[key:OTHER_PRIVATE_KEY]https://other.invalid/api/v1/";
const playlist = "https://television.invalid/live.m3u";
acorn.parse(adapter, { ecmaVersion: 5 });

function transpile(source) {
    return ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }).outputText;
}

function declarations(file, names) {
    names = sourceNames(file, names);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const selected = ast.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name.text)
    );
    assert.equal(
        selected.length,
        names.length,
        "all production functions found"
    );
    return transpile(
        selected
            .map((node) => node.getText(ast).replace(/^export\s+/, ""))
            .join("\n")
    );
}

const clientCode = bundled
    ? read("dist/player.js")
    : declarations("src/utils/helpers.ts", [
          "metadataText",
          "metadataImageUrl",
      ]) +
      transpile(
          read("src/plugins/vportal.ts")
              .replace(/^import[^;]+;\s*/gm, "")
              .replace(/^export\s+/gm, "")
      );
const cancellationCode = declarations("src/channels/index.ts", [
    "rememberMediaView",
    "cancelMediaLoad",
]);
const editorCode = declarations("src/ui/index.ts", ["editKey2"]);

function fixture(
    slots = [{ medUrl: portal, name: "Home", rechours: 0, www: playlist }],
    browser = "chrome"
) {
    const dom = new JSDOM(
        "<!doctype html><video id='video'></video><div id='dialogbox'></div>",
        {
            runScripts: "outside-only",
            url: "https://player.invalid/",
        }
    );
    const w = dom.getInternalVMContext();
    w.setTimeout = w.setInterval = () => 1;
    w.console = { error() {}, log() {}, warn() {} };
    if (bundled) vm.runInContext(read("js/runtime-polyfills.js"), w);
    require("./helpers/shared-core-runtime.cjs")(w);
    vm.runInContext(clientCode, w);
    if (!process.argv.includes("--bundle")) attachSourceAliases(w);
    const saved = new Map([
        ["m3um3uArr", JSON.stringify({ active: 0, M3Us: slots })],
    ]);
    const requests = [];
    const alerts = [];
    const played = [];
    const created = [];
    const chain = {
        append() {
            return this;
        },
        hide() {
            return this;
        },
        html() {
            return this;
        },
        show() {
            return this;
        },
    };
    const jq = () => chain;
    jq.ajax = (options) => {
        const call = {
            aborted: false,
            options,
            reply(data) {
                if (options.success) options.success(data, "success", {});
                if (options.complete) options.complete();
            },
        };
        requests.push(call);
        return {
            abort() {
                call.aborted = true;
                if (options.error) options.error({}, "abort");
                if (options.complete) options.complete();
            },
            always() {
                return this;
            },
            done() {
                return this;
            },
            fail() {
                return this;
            },
        };
    };
    Object.assign(w, {
        _: (text) => text,
        _playMedia: (item) => played.push(item),
        $: jq,
        alert: (message) => alerts.push(message),
        browserName: () => browser,
        btnDiv: () => "",
        cats: {},
        catsArray: [],
        chanels: {},
        checkProviderUrl: () => true,
        cList: [],
        client_can: { crossxhr: false },
        closeList() {},
        curColor: "white",
        curList: [],
        getMediaArray: null,
        host: "https://player.invalid",
        jQuery: jq,
        keys: { ENTER: 13, RETURN: 27, STOP: 19 },
        launch_id: "#launch",
        listCaption: {},
        listDetail: {},
        listPodval: {},
        loadChannels() {},
        medFavorites: [],
        medHistory: [],
        mediaName: "",
        mediaNames: [],
        mediaRecords: [],
        mediaRecordsPar: null,
        mediaSelects: [0],
        mediaUrls: null,
        murmurhash3_32_gc: () => 123,
        noProvParam() {},
        pdsa: ["medHistory", "medFavorites"],
        popupActions: [],
        popupArray: [],
        popupDetail: [],
        primaryIndex: 0,
        providerMediaClient: null,
        StripHttp: (value) => value.replace(/^https?:/, ""),
        showEditKey() {},
        showPage() {},
        sNoNumbersKeys: false,
        sPageSize: 30,
        stb: { getMacAddress: () => "00:11:22:33:44:55" },
        stbDelItem: (key) => saved.delete(key),
        stbGetItem: (key) => (saved.has(key) ? saved.get(key) : null),
        stbSetItem: (key, value) => saved.set(key, String(value)),
        strENTER: "Enter",
        strNew: "",
        strRETURN: "Return",
        updateChanelInfo() {},
        version: "fixture",
        xxHash32S: () => 1,
        xxHash32Si: () => 2,
    });
    w.playMedia = w._playMedia;
    const create = w.createVPortalClient;
    assert.equal(
        typeof create,
        "function",
        "the shared client is present in the selected runtime"
    );
    w.createVPortalClient = (link, options) => {
        const client = create(link, options);
        created.push(client);
        return client;
    };
    if (!bundled) vm.runInContext(cancellationCode, w);
    vm.runInContext(adapter, w);
    if (!process.argv.includes("--bundle")) attachSourceAliases(w);
    w.duneAddSettings(0);
    return { alerts, created, dom, played, requests, saved, w };
}

let cases = 0;
function test(name, run) {
    run();
    cases++;
    console.log("PASS M3U VPortal: " + name);
}

test("saved portal links stay inert across browser and Dune startup and refresh", () => {
    for (const browser of ["chrome", "dune"])
        for (const medUrl of [portal, "  PoRtAl::invalid  "]) {
            const slot = { medSourceId: "keep-source", medUrl, www: playlist };
            const { alerts, created, requests, saved, w } = fixture(
                [slot],
                browser
            );
            const before = saved.get("m3um3uArr");
            w.duneAddSettings(0);
            w.m3uUpdateMedia();
            assert.equal(created.length, 0);
            assert.equal(requests.length, 0);
            assert.equal(alerts.length, 0);
            assert.equal(w.getMediaArray, null);
            assert.equal(w.providerMediaClient, null);
            assert.equal(w.playMedia, w._playMedia);
            assert.equal(saved.get("m3um3uArr"), before);
            assert.equal(w.m3uArr.M3Us[0].medUrl, medUrl);
            assert.equal(w.m3uArr.M3Us[0].medSourceId, "keep-source");
        }
});

test("slot changes retire previous media client without activating another saved portal", () => {
    const { created, requests, w } = fixture([
        { medUrl: portal, www: playlist },
        { medUrl: otherPortal, www: playlist },
    ]);
    let disposed = 0;
    const load = () => {};
    w.providerMediaClient = {
        dispose: () => disposed++,
        load,
        m3uActive: 1,
        m3uSource: otherPortal,
    };
    w.getMediaArray = load;
    w.mediaRecords = [{ title: "Old" }];
    w.m3uArr.active = 1;
    w.m3uUpdateMedia();
    assert.equal(disposed, 1);
    assert.equal(created.length, 0);
    assert.equal(requests.length, 0);
    assert.equal(w.getMediaArray, null);
    assert.equal(w.providerMediaClient, null);
    assert.equal(w.mediaRecords.length, 0);
});

function editField(w, index, value) {
    w.doEditListData(0);
    w.selIndex = index;
    w.listKeyHandler(w.keys.ENTER);
    w.editvar = value;
    w.setEdit();
}

test("M3U settings omit the portal field and summary while preserving stored values", () => {
    const { alerts, saved, w } = fixture([
        { medSourceId: "keep-source", medUrl: portal, www: playlist },
    ]);
    w.doEditListData(0);
    assert.equal(w.listArray.length, 5);
    assert.equal(w.listArray[4], "Load playlist");
    assert(!/VPortal|PRIVATE_KEY|portal.invalid/.test(w.listArray.join(" ")));
    w.doEditM3Ua(0);
    w.detailListAction();
    assert(!/VPortal|PRIVATE_KEY|portal.invalid/.test(w.listDetail.innerHTML));
    editField(w, 0, "Updated TV");
    const slot = JSON.parse(saved.get("m3um3uArr")).M3Us[0];
    assert.equal(slot.name, "Updated TV");
    assert.equal(slot.medUrl, portal);
    assert.equal(slot.medSourceId, "keep-source");
    assert.equal(alerts.length, 0);
});

test("invalid HTML editor submissions reopen after editor teardown with their typed value intact", () => {
    for (const [index, typed] of [[1, otherPortal]]) {
        const { saved, w } = fixture();
        if (!bundled) vm.runInContext(editorCode, w);
        const before = saved.get("m3um3uArr");
        const events = [];
        const timers = [];
        w.setTimeout = (callback) => timers.push(callback);
        w.showEditKey = () => {
            w.__ottClassicScreenPort.openEditor();
            events.push(["open", w.editvar]);
        };
        w.restoreCPD = () => events.push(["restore"]);
        w.doEditListData(0);
        w.selIndex = index;
        w.listKeyHandler(w.keys.ENTER);
        events.length = 0;
        w.$ = (selector) => ({
            hide() {
                events.push(["hide", selector]);
            },
            val: () => typed,
        });
        w.editKey2(w.keys.ENTER);
        assert.deepEqual(events, [
            ["hide", "#listEdit"], // owner disposal hides the retired input
            ["hide", "#listEdit"], // retained editor renderer teardown
            ["restore"],
        ]);
        assert.equal(saved.get("m3um3uArr"), before);
        assert.equal(timers.length, 1);
        timers.shift()();
        assert.deepEqual(events[3], ["open", typed]);
    }
});

test("ordinary television loading ignores a saved legacy portal", () => {
    const { requests, w } = fixture();
    let completed = 0;
    w.getChanelsArray(() => completed++);
    assert.equal(requests[0].options.url, playlist);
    requests[0].reply(
        '#EXTM3U\n#EXTINF:-1 group-title="News" tvg-logo="https://tv.invalid/logo.png",News HD\nhttps://tv.invalid/live.m3u8\n'
    );
    assert.equal(completed, 1);
    assert.equal(w.cList.length, 1);
    assert.equal(w.chanels[w.cList[0]].channel_name, "News HD");
    assert.equal(w.chanels[w.cList[0]].url, "https://tv.invalid/live.m3u8");
    assert.equal(w.getMediaArray, null);
});

test("a portal pasted into Playlist URL is rejected before any network request", () => {
    const { alerts, requests, saved, w } = fixture([{ www: portal }]);
    let completed = 0;
    w.getChanelsArray(() => completed++);
    assert.equal(completed, 1);
    assert.equal(requests.length, 0);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0], "Enter playlist URL");
    assert(!alerts[0].includes("FIXTURE_PRIVATE_KEY"));
    assert(!w.popupArray.join(" ").includes("FIXTURE_PRIVATE_KEY"));
    w.doEditM3Ua(0);
    assert(!w.getListItem(w.m3uArr.M3Us[0], 0).includes("FIXTURE_PRIVATE_KEY"));
    w.detailListAction();
    assert(!w.listDetail.innerHTML.includes("FIXTURE_PRIVATE_KEY"));
    w.doEditListData(0);
    assert(!w.listArray.join(" ").includes("FIXTURE_PRIVATE_KEY"));
    w.m3uArr.M3Us[0].www = playlist;
    w.providerSetItem("m3uArr", JSON.stringify(w.m3uArr));
    const before = saved.get("m3um3uArr");
    editField(w, 1, portal);
    assert.equal(w.m3uArr.M3Us[0].www, playlist);
    assert.equal(saved.get("m3um3uArr"), before);
    assert.equal(requests.length, 0);
});

test("direct legacy Dune loader ignores portal links without network access", () => {
    const { requests, w } = fixture(
        [{ medUrl: portal, www: playlist }],
        "dune"
    );
    let completed = 0;
    w._getMediaArray("", () => completed++);
    w._getMediaArray(otherPortal, () => completed++);
    assert.equal(completed, 2);
    assert.equal(requests.length, 0);
    assert.equal(w.mediaRecords.length, 0);
});

test("saved legacy catalogs retain their Dune-only loader", () => {
    const slots = [
        { medUrl: "https://catalog.invalid/library.json", www: playlist },
    ];
    const browser = fixture(slots);
    assert.equal(browser.w.getMediaArray, null);
    const dune = fixture(slots, "dune");
    assert.equal(dune.w.getMediaArray, dune.w._getMediaArray);
    assert.equal(dune.w.playMedia, dune.w._playMedia);
});

console.log(
    "PASS M3U VPortal integration (" +
        cases +
        " cases" +
        (bundled ? ", classic bundle" : ", source") +
        ")"
);
