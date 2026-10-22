const {
    attachSourceAliases,
    sourceName,
    sourceNames,
} = require("./helpers/english-source-fixture.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const bundle = process.argv.includes("--bundle");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function declarations(file, names) {
    names = sourceNames(file, names);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    return ast.statements
        .filter(
            (node) =>
                ts.isFunctionDeclaration(node) && names.includes(node.name.text)
        )
        .map((node) => node.getText(ast).replace(/^export\s+/, ""))
        .join("\n");
}

function variable(file, name) {
    name = sourceName(file, name);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    for (const node of ast.statements)
        if (ts.isVariableStatement(node))
            for (const item of node.declarationList.declarations)
                if (item.name.getText(ast) === name)
                    return "var " + item.getText(ast) + ";";
    throw new Error("Missing variable: " + name);
}

function assignment(file, name) {
    name = sourceName(file, name);
    const ast = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    return ast.statements
        .find(
            (node) =>
                ts.isExpressionStatement(node) &&
                ts.isBinaryExpression(node.expression) &&
                node.expression.left.getText(ast) === name
        )
        .getText(ast);
}

const source = bundle
    ? read("dist/player.js")
    : ts.transpileModule(
          [
              read("src/channels/favorites-lists.ts").replace(
                  /^export\s+/gm,
                  ""
              ),
              variable("src/key-handler/index.ts", "keys"),
              declarations("src/channels/index.ts", [
                  "addToFavorites",
                  "removeFromFavorites",
                  "saveChannelsCats",
                  "refreshFavoritesViewIfActive",
                  "channelsKeyHandler",
                  "moveChannel",
                  "deleteChannel",
                  "hasParentalLock",
                  "ifParentalAccess",
                  "ifParentalAccessChId",
                  "onChanelsLoaded",
              ]),
              declarations("src/ui/index.ts", [
                  "withPipChannelAccess",
                  "playPipChannel",
                  "togglePip",
                  "popTogglePip",
                  "closeList",
              ]),
              assignment("src/index.ts", "window.addChannel2bucket"),
              "bindFavoritesViewRefresh(refreshFavoritesViewIfActive);",
          ].join("\n"),
          {
              compilerOptions: {
                  module: ts.ModuleKind.None,
                  target: ts.ScriptTarget.ES5,
              },
          }
      ).outputText;

function fixture(saved = new Map()) {
    const dom = new JSDOM(
        '<div id="listPopUp"></div><div id="list_osd"></div><div id="list_window"></div><div id="permanentTime"></div><video id="video"></video><video id="videopip"></video>',
        { runScripts: "outside-only", url: "https://fixture.invalid/" }
    );
    const w = dom.window;
    w.setTimeout = w.setInterval = w.requestAnimationFrame = () => 1;
    w.console = { debug() {}, error() {}, info() {}, log() {}, warn() {} };
    w.confirm = () => false;
    if (bundle) w.eval(read("js/runtime-polyfills.js"));
    w.eval(read("js/jquery-1.11.1.min.js"));
    if (!process.argv.includes("--bundle")) attachSourceAliases(w);
    w.$.expr.filters.visible = (element) => element.style.display !== "none";
    require("./helpers/shared-core-runtime.cjs")(dom.getInternalVMContext());
    vm.runInContext(source, dom.getInternalVMContext(), { timeout: 10000 });
    if (!process.argv.includes("--bundle"))
        attachSourceAliases(dom.getInternalVMContext());
    const calls = [];
    const guideUpdates = [];
    const pending = [];
    Object.assign(w, {
        _: (value) => value,
        cancelMediaLoad() {},
        catIndex: 1,
        cats: { All: [1, 2, 3], Second: [10, 20] },
        catsArray: ["Favorites", "All", "Second"],
        channels: { 1: {}, 2: {}, 3: {}, 8: {}, 9: {}, 10: {}, 20: {} },
        curList: [1, 2, 3],
        enterPinAndSetAccess: (callback) => pending.push(callback),
        getChannelUrl: (id) => "https://fixture.invalid/channel/" + id,
        isListVisible: true,
        listArray: [1, 2, 3],
        listCatIndex: 1,
        listElement: null,
        loadEpgTimers() {},
        parentAccess: false,
        parentalArray: [],
        parentPIN: "1234",
        pipCatIndex: 0,
        pipIndex: null,
        playChannel: (category, index) => {
            calls.push(["main", category, index]);
            w.catIndex = category;
            w.primaryIndex = index;
            w.curList = w.cats[w.catsArray[category]];
        },
        primaryIndex: 0,
        providerGetItem: (key) => saved.get(key) ?? null,
        providerGetJson: (key, fallback) =>
            saved.has(key) ? JSON.parse(saved.get(key)) : fallback,
        providerSetItem: (key, value) => saved.set(key, String(value)),
        restoreContinueWatch: () => false,
        selIndex: 0,
        settings: { permanentTime: 0, psChannels: 1 },
        sFavorites: 1,
        showPage() {},
        showShift() {},
        sNoSmall: 0,
        sPreview: 0,
        stbPlayPip: (url) => calls.push(["pip", url]),
        stbToFullScreen() {},
        updateChannelInfo(id) {
            guideUpdates.push(id);
        },
    });
    w.changeSelect = (delta) => {
        w.selIndex =
            (w.selIndex + delta + w.listArray.length) % w.listArray.length;
    };
    w.loadFavoritesLists();
    w.cats.Favorites = w.favoritesArray;
    return {
        calls,
        close: () => dom.window.close(),
        guideUpdates,
        pending,
        saved,
        w,
    };
}

let passed = 0;
const failures = [];
function test(name, action) {
    const f = fixture();
    try {
        action(f);
        passed++;
        console.log("PASS favorites/access: " + name);
    } catch (error) {
        failures.push(name + ": " + error.message);
        console.error("FAIL favorites/access: " + name + ": " + error.message);
    } finally {
        f.close();
    }
}
const list = (value) => Array.from(value);
const references = (...ids) => ids.map((id) => ({ itemId: "channel:" + id }));
const stored = (f) =>
    JSON.parse(
        f.saved.get("favoritesLibrary:" + f.w.__ottSourceIdentity.current(f.w))
    ).lists;

test("UI add persists once and survives reopening the provider", (f) => {
    f.w.channelsKeyHandler(f.w.keys.N3);
    f.w.channelsKeyHandler(f.w.keys.N3);
    assert.deepEqual(stored(f).lists.Favorites, references(1));
    const reopened = fixture(f.saved);
    try {
        assert.deepEqual(list(reopened.w.favoritesArray), [1]);
    } finally {
        reopened.close();
    }
});

test("UI move and delete persist the active favorites list", (f) => {
    [1, 2, 3].forEach((id) => f.w.addToFavorites(id));
    f.w.saveChannelsCats();
    f.w.cList = [1, 2, 3];
    f.w.__ottChannels.mount(f.w);
    f.w.listCatIndex = 0;
    f.w.listArray = f.w.cats.Favorites;
    f.w.channelsKeyHandler(f.w.keys.N7);
    assert.deepEqual(stored(f).lists.Favorites, references(2, 1, 3));
    f.w.channelsKeyHandler(f.w.keys.N8);
    assert.deepEqual(stored(f).lists.Favorites, references(2, 3));
    f.w.loadFavoritesLists();
    assert.deepEqual(list(f.w.favoritesArray), [2, 3]);
});

test("public add/remove helpers share the legacy arrays without duplicate mutations", (f) => {
    f.w.addToFavorites(1);
    f.w.addToFavorites(1);
    f.w.addToFavorites(2);
    f.w.removeFromFavorites(1);
    f.w.saveChannelsCats();
    assert.deepEqual(list(f.w.cats.Favorites), [2]);
    assert.equal(f.w.favoritesArray, f.w.favoritesLists.lists.Favorites);
    assert.equal(f.w.cats.Favorites, f.w.favoritesArray);
    assert.deepEqual(stored(f).lists.Favorites, references(2));
});

test("switch, rename and delete preserve independent lists and active view", (f) => {
    f.w.addToFavorites(1);
    f.w.addFavoritesList("Second list");
    f.w.setActiveFavoritesList("Second list");
    f.w.addToFavorites(2);
    f.w.addToFavorites(3);
    f.w.catIndex = 0;
    f.w.primaryIndex = 1;
    f.w.setActiveFavoritesList("Favorites");
    assert.deepEqual(list(f.w.curList), [1]);
    assert.equal(f.w.primaryIndex, 0);
    f.w.renameFavoritesList("Favorites", "Renamed");
    f.w.saveChannelsCats();
    assert.equal(stored(f).active, "Renamed");
    assert.deepEqual(stored(f).lists["Second list"], references(2, 3));
    f.w.deleteFavoritesList("Renamed");
    f.w.saveChannelsCats();
    assert.equal(stored(f).active, "Second list");
    assert.deepEqual(list(f.w.curList), [2, 3]);
    assert.equal(f.w.curList, f.w.favoritesArray);
});

test("legacy single-list migration stays mutable through the UI", (f) => {
    f.saved.delete("favoritesLibrary:" + f.w.__ottSourceIdentity.current(f.w));
    f.saved.set("favoritesArray", JSON.stringify([2]));
    f.w.loadFavoritesLists();
    f.w.cats.Favorites = f.w.favoritesArray;
    f.w.channelsKeyHandler(f.w.keys.N3);
    assert.deepEqual(stored(f).lists.Favorites, references(2, 1));
});

test("loading a provider in category mode preserves that provider's favorites", (f) => {
    f.w.addToFavorites(1);
    f.saved.set(
        "favoritesLists",
        JSON.stringify({
            active: "Other provider",
            lists: { "Other provider": [2] },
            order: ["Other provider"],
            v: 1,
        })
    );
    f.saved.delete("favoritesLibrary:" + f.w.__ottSourceIdentity.current(f.w));
    f.w.sFavorites = 0;
    f.w.cList = [1, 2, 3];
    f.w.catsArray = [];
    f.w.cats = {};
    f.w.onChanelsLoaded();
    f.w.saveChannelsCats();
    assert.equal(stored(f).active, "Other provider");
    assert.deepEqual(stored(f).lists["Other provider"], references(2));
});

for (const key of ["PIP", "STOP", "N5"])
    test(
        "locked list selection requires PIN before " +
            key +
            " playback or state changes",
        (f) => {
            f.w.parentalArray = [1];
            f.w.$("#listPopUp").hide();
            f.w.channelsKeyHandler(f.w.keys[key]);
            assert.equal(f.pending.length, 1);
            assert.deepEqual(f.calls, []);
            assert.equal(f.w.pipIndex, null);
            assert.equal(f.w.isListVisible, true);
            f.w.parentAccess = true;
            f.pending[0]();
            assert.deepEqual(f.calls, [
                ["pip", "https://fixture.invalid/channel/1"],
            ]);
            assert.equal(f.w.pipIndex, 0);
            assert.equal(f.w.pipCatIndex, 1);
            assert.equal(f.w.isListVisible, false);
        }
    );

test("unlocked and disabled parental-control paths start PiP without prompts", (f) => {
    f.w.channelsKeyHandler(f.w.keys.PIP);
    assert.equal(f.pending.length, 0);
    assert.equal(f.calls.length, 1);
    f.w.parentalArray = [2];
    f.w.settings.psChannels = 0;
    f.w.selIndex = 1;
    f.w.channelsKeyHandler(f.w.keys.PIP);
    assert.equal(f.pending.length, 0);
    assert.equal(f.calls.at(-1)[1], "https://fixture.invalid/channel/2");
});

test("closing an overlay rechecks access before restoring PiP", (f) => {
    f.w.pipCatIndex = 2;
    f.w.pipIndex = 1;
    f.w.parentalArray = [20];
    f.w.closeList();
    assert.equal(f.pending.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(
        f.guideUpdates,
        [1],
        "The playing footer is restored while PiP awaits PIN"
    );
    f.w.parentAccess = true;
    f.pending[0]();
    assert.deepEqual(f.calls, [["pip", "https://fixture.invalid/channel/20"]]);
});

test("main-screen PiP checks an expired parental session", (f) => {
    f.w.parentalArray = [1];
    f.w.togglePip();
    assert.equal(f.pending.length, 1);
    assert.equal(f.w.pipIndex, null);
    assert.deepEqual(f.calls, []);
});

for (const locked of [1, 20])
    test(
        "PiP exchange checks both channel IDs before swapping: " + locked,
        (f) => {
            f.w.pipCatIndex = 2;
            f.w.pipIndex = 1;
            f.w.parentalArray = [locked];
            f.w.popTogglePip();
            assert.equal(f.pending.length, 1);
            assert.deepEqual(f.calls, []);
            assert.equal(f.w.catIndex, 1);
            assert.equal(f.w.pipCatIndex, 2);
            f.w.parentAccess = true;
            f.pending[0]();
            assert.deepEqual(f.calls, [
                ["main", 2, 1],
                ["pip", "https://fixture.invalid/channel/1"],
            ]);
            assert.equal(f.w.pipCatIndex, 1);
            assert.equal(f.w.pipIndex, 0);
            assert.equal(f.w.catIndex, 2);
        }
    );

test("PIN completion does not revive a channel replaced during provider reload", (f) => {
    f.w.parentalArray = [1];
    f.w.channelsKeyHandler(f.w.keys.PIP);
    assert.equal(f.pending.length, 1);
    f.w.channels[1] = { replacement: true };
    f.w.parentAccess = true;
    f.pending[0]();
    assert.deepEqual(f.calls, []);
    assert.equal(f.w.pipIndex, null);
});

test("exchange does not use an old PiP target replaced while the main-channel PIN is pending", (f) => {
    f.w.pipCatIndex = 2;
    f.w.pipIndex = 1;
    f.w.parentalArray = [1];
    f.w.togglePip();
    assert.equal(f.pending.length, 1);
    f.w.channels[20] = { replacement: true };
    f.w.parentAccess = true;
    f.pending[0]();
    assert.deepEqual(f.calls, []);
    assert.equal(f.w.pipCatIndex, 2);
    assert.equal(f.w.pipIndex, 1);
});

test("a missing channel cannot start or replace PiP", (f) => {
    f.w.selIndex = 99;
    f.w.channelsKeyHandler(f.w.keys.PIP);
    assert.deepEqual(f.calls, []);
    assert.equal(f.pending.length, 0);
    assert.equal(f.w.pipIndex, null);
});

const capturedSelections = JSON.parse(
    read("tests/fixtures/state/favorites-before-core.json")
);
for (const input of capturedSelections)
    test("captured state: " + input.name, (f) => {
        f.saved.delete(
            "favoritesLibrary:" + f.w.__ottSourceIdentity.current(f.w)
        );
        f.saved.set("favoritesLists", JSON.stringify(input.initial));
        f.saved.set("favoritesArray", JSON.stringify(input.prior || []));
        let syncs = 0;
        f.w.bindFavoritesViewRefresh(() => {
            syncs++;
        });
        f.w.loadFavoritesLists();
        const before = { ...f.w.favoritesLists.lists };
        let result, error;
        try {
            result = f.w[input.operation](...(input.args || []));
        } catch (failure) {
            error = { message: failure.message, name: failure.name };
        }
        const state = f.w.favoritesLists,
            lists = state.lists;
        const output = {
            origins: Object.keys(lists).map((key) => [
                key,
                Object.keys(before).filter((old) => before[old] === lists[key]),
            ]),
            result:
                result === undefined
                    ? { undefined: true }
                    : JSON.parse(JSON.stringify(result)),
            state: JSON.parse(JSON.stringify(state)),
        };
        if (error) output.error = error;
        output.syncs = syncs;
        output.alias = f.w.favoritesArray === state.lists[state.active];
        output.aliasType = typeof f.w.favoritesArray;
        assert.deepEqual(output, input.expected);
    });

if (failures.length) throw new Error(failures.join("\n"));
console.log(
    "PASS favorites/access contract: " +
        passed +
        " scenarios (" +
        (bundle ? "full classic bundle" : "source") +
        ")"
);
