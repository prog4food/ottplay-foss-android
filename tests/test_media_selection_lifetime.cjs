/* Run the actual standalone library and delayed search consumer without loading any player/core fixture. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

function compile(source, module = ts.ModuleKind.CommonJS) {
    const result = ts.transpileModule(source, {
        compilerOptions: { module, target: ts.ScriptTarget.ES5 },
        reportDiagnostics: true,
    });
    assert.deepEqual(
        (result.diagnostics || []).filter(
            (entry) => entry.category === ts.DiagnosticCategory.Error
        ),
        []
    );
    return result.outputText;
}
const librarySource = fs.readFileSync(
    path.join(root, "src/media/library.ts"),
    "utf8"
);
const libraryAst = ts.createSourceFile(
    "library.ts",
    librarySource,
    ts.ScriptTarget.Latest,
    true
);
assert.equal(
    ts.isExternalModule(libraryAst),
    false,
    "The library must remain a standalone source module"
);
const libraryCode = compile(librarySource);
const channelsAst = ts.createSourceFile(
    "channels.ts",
    fs.readFileSync(path.join(root, "src/channels/index.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const searchFunctions = channelsAst.statements.filter(
    (node) =>
        ts.isFunctionDeclaration(node) && node.name?.text === "searchMedia"
);
assert.equal(searchFunctions.length, 1);
const searchCode = compile(
    searchFunctions[0].getText(channelsAst),
    ts.ModuleKind.CommonJS
);

function item(itemId, sourceId = "source-a", payload = {}) {
    return {
        payload: { ...payload },
        ref: { itemId, sourceId },
        title: itemId,
    };
}
function fixture(rows = [item("A"), item("B")], hooks = {}) {
    const context = vm.createContext({ exports: {}, window: {} });
    vm.runInContext(libraryCode, context, { filename: "src/media/library.ts" });
    let loaded;
    const pages = [];
    const library = context.window.__ottMediaLibrary.create({
        describe: hooks.describe || ((records) => records),
        filter: hooks.filter,
        items: () => [],
        load: (_route, done) => {
            loaded = done;
            done(rows);
        },
        page:
            hooks.page ||
            ((_route, done) => {
                pages.push(done);
            }),
        render: () => {},
    });
    library.open({ kind: "catalog", target: "root", title: "Catalog" });
    return {
        context,
        frame: () => library.snapshot().frame,
        library,
        pages,
        refresh: (records, selected) =>
            loaded.update(records, undefined, selected),
    };
}

for (const method of ["highlight", "select", "highlightRef"]) {
    test(`${method}: leaving and returning to A cannot revive its captured action`, () => {
        const f = fixture();
        const admitted = f.library.capture();
        const move = (index) =>
            method === "highlightRef"
                ? f.library.highlightRef({
                      itemId: index ? "B" : "A",
                      sourceId: "source-a",
                  })
                : f.library[method](index);
        move(1);
        assert.equal(admitted(), false);
        move(0);
        assert.equal(
            admitted(),
            false,
            "Returning to the old tuple is a new selection lifetime"
        );
        assert.equal(f.frame().selected, 0);
        assert.equal(f.library.capture()(), true);
    });
}

for (const [name, replacement] of [
    ["item identity", item("other")],
    ["source identity", item("A", "source-b")],
]) {
    test(`same-index ${name} replacement permanently revokes the prior action`, () => {
        const f = fixture();
        const admitted = f.library.capture();
        f.library.replaceItems([replacement, item("B")]);
        assert.equal(admitted(), false);
        f.library.replaceItems([item("A"), item("B")]);
        assert.equal(admitted(), false);
        assert.equal(f.frame().selected, 0);
    });
}

test("moving the selected identity to another index and back cannot revive a capture", () => {
    const f = fixture([item("B"), item("A")]);
    f.library.highlight(1);
    const admitted = f.library.capture();
    f.library.replaceItems([item("A"), item("B")]);
    assert.equal(f.frame().selected, 0);
    assert.equal(admitted(), false);
    f.library.replaceItems([item("B"), item("A")]);
    assert.equal(f.frame().selected, 1);
    assert.equal(admitted(), false);
});

test("emptying and restoring a catalog does not revive the former selection", () => {
    const f = fixture();
    const admitted = f.library.capture();
    f.library.replaceItems([]);
    assert.equal(admitted(), false);
    f.library.replaceItems([item("A"), item("B")]);
    assert.equal(admitted(), false);
    assert.equal(f.frame().selected, 0);
});

test("initially empty selection cannot revive after an item appears and disappears", () => {
    const f = fixture([]);
    const admitted = f.library.capture();
    f.library.replaceItems([item("A")]);
    assert.equal(admitted(), false);
    f.library.replaceItems([]);
    assert.equal(admitted(), false);
    assert.equal(f.frame().selected, 0);
});

test("explicit provider update selection cannot revive a prior index lifetime", () => {
    const f = fixture();
    const admitted = f.library.capture();
    const frameAdmitted = f.library.capture("frame");
    f.refresh([item("A"), item("B")], 1);
    assert.equal(f.frame().selected, 1);
    assert.equal(admitted(), false);
    f.refresh([item("A"), item("B")], 0);
    assert.equal(f.frame().selected, 0);
    assert.equal(admitted(), false);
    assert.equal(frameAdmitted(), true);
});

test("same tuple refresh and repeated highlights preserve the current action", () => {
    const f = fixture();
    f.library.highlight(1);
    const admitted = f.library.capture();
    f.library.highlight(1);
    f.library.select(1);
    f.library.highlightRef({ itemId: "B", sourceId: "source-a" });
    f.library.highlight(100);
    f.library.highlightRef({ itemId: "missing", sourceId: "source-a" });
    f.refresh([item("A"), item("B", "source-a", { url: "fresh.mp4" })]);
    assert.equal(admitted(), true);
    f.library.replaceItems([
        item("A"),
        item("B", "source-a", { url: "newer.mp4" }),
    ]);
    assert.equal(admitted(), true);
    assert.equal(f.frame().selected, 1);
    assert.equal(f.frame().items[1].payload.url, "newer.mp4");
});

test("frame capture survives highlight and paging while retaining the final selected index", () => {
    const f = fixture([
        item("A"),
        item("B"),
        item("next", "source-a", {
            __ottMediaNext: true,
            playlist_url: "page-2",
        }),
    ]);
    const frameAdmitted = f.library.capture("frame");
    f.library.highlight(1);
    const selectedAdmitted = f.library.capture();
    f.library.more();
    assert.equal(f.pages.length, 1);
    assert.equal(frameAdmitted(), true);
    f.pages.shift()([item("C")]);
    assert.equal(frameAdmitted(), true);
    assert.equal(selectedAdmitted(), true);
    assert.equal(f.frame().selected, 1);
    assert.equal(f.frame().items[1].ref.itemId, "B");
});

test("paging replaces the selected cursor at its final index and revokes only its action", () => {
    const f = fixture([
        item("A"),
        item("next", "source-a", {
            __ottMediaNext: true,
            playlist_url: "page-2",
        }),
    ]);
    f.library.highlight(1);
    const admitted = f.library.capture();
    const frameAdmitted = f.library.capture("frame");
    f.library.more(true);
    f.pages.shift()([item("B"), item("C")]);
    assert.equal(f.frame().selected, 1);
    assert.equal(f.frame().items[1].ref.itemId, "B");
    assert.equal(admitted(), false);
    assert.equal(frameAdmitted(), true);
});

test("filtered, empty and synchronous pages settle the cursor at a valid final selection", () => {
    for (const scenario of [
        {
            id: "B",
            index: 1,
            records: [item("hidden", "source-a", { hidden: true }), item("B")],
        },
        { id: "A", index: 0, records: [] },
        { id: "B", index: 1, records: [item("B")], synchronous: true },
    ]) {
        const f = fixture(
            [
                item("A"),
                item("next", "source-a", {
                    __ottMediaNext: true,
                    playlist_url: "page-2",
                }),
            ],
            {
                filter: (rows) => rows.filter((row) => !row.payload.hidden),
                page: scenario.synchronous
                    ? (_route, done) => done(scenario.records)
                    : undefined,
            }
        );
        f.library.highlight(1);
        const admitted = f.library.capture();
        const frameAdmitted = f.library.capture("frame");
        f.library.more(true);
        if (!scenario.synchronous) f.pages.shift()(scenario.records);
        const frame = f.frame();
        assert.equal(frame.selected, scenario.index);
        assert.equal(frame.items[frame.selected].ref.itemId, scenario.id);
        assert.equal(admitted(), false);
        assert.equal(frameAdmitted(), true);
        assert.equal(f.library.capture()(), true);
    }
});

test("refilter and frame replacement revoke frame-scoped captures", () => {
    const f = fixture();
    const beforeFilter = f.library.capture("frame");
    f.library.refilter();
    assert.equal(beforeFilter(), false);
    const beforeOpen = f.library.capture("frame");
    f.library.open({ kind: "catalog", target: "child", title: "Child" });
    assert.equal(beforeOpen(), false);
});

for (const port of ["filter", "describe"]) {
    test(`reentrant ${port} cannot retire an action captured in a newer frame`, () => {
        let reenter = false,
            library,
            newerAction;
        const f = fixture([item("A"), item("B")], {
            [port]: (rows) => {
                if (reenter) {
                    reenter = false;
                    library.open({
                        kind: "catalog",
                        target: "newer",
                        title: "Newer",
                    });
                    newerAction = library.capture();
                }
                return rows;
            },
        });
        library = f.library;
        reenter = true;
        if (port === "filter") library.replaceItems([item("replacement")]);
        else f.refresh([item("replacement")]);
        assert.equal(f.frame().route.target, "newer");
        assert.equal(f.frame().selected, 0);
        assert.equal(newerAction(), true);
    });
}

function searchFixture() {
    const f = fixture();
    const writes = [],
        opens = [];
    Object.assign(f.context.window, {
        _: (value) => value,
        __ottMedia: {
            capture: () => f.library.capture(),
            open: (...args) => opens.push(args),
        },
        listArray: f.frame().items,
        mediaList: () => {},
        stbGetItem: () => "",
        stbSetItem: (...args) => writes.push(args),
    });
    f.context.document = { getElementById: () => ({ value: "new query" }) };
    vm.runInContext(searchCode, f.context, {
        filename: "src/channels/index.ts:searchMedia",
    });
    f.context.exports.searchMedia({
        playlist_url: "catalog?fixture=1",
        title: "Search",
    });
    return { ...f, opens, writes };
}

test("actual searchMedia delayed submit rejects A-to-B-to-A navigation", () => {
    const f = searchFixture();
    const sourceList = f.context.window.listArray;
    f.library.highlight(1);
    f.library.highlight(0);
    assert.equal(
        f.context.window.listArray,
        sourceList,
        "Scalar highlights leave the UI projection intact"
    );
    f.context.window.setEdit();
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.opens, []);
    assert.equal(f.frame().selected, 0);
});

test("actual searchMedia delayed submit accepts an unchanged selection", () => {
    const f = searchFixture();
    f.library.highlight(0);
    f.context.window.setEdit();
    assert.deepEqual(f.writes, [["medSearch", "new query"]]);
    assert.deepEqual(f.opens, [
        ["catalog?fixture=1&search=new%20query", "Search"],
    ]);
});
