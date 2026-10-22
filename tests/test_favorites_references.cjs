const assert = require("node:assert/strict");
const fs = require("node:fs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
const compile = (file) =>
    ts.transpileModule(
        fs
            .readFileSync(path.join(root, file), "utf8")
            .replace(/^export /gm, ""),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
const code =
    compile("src/channels/channel-references.ts") +
    "\n" +
    compile("src/channels/favorites-lists.ts");
acorn.parse(code, { ecmaVersion: 5 });
const plain = (value) => JSON.parse(JSON.stringify(value));
const rows = () => ({
    10: { itemId: "stream:A", legacyChannelId: 100 },
    20: { itemId: "stream:B", legacyChannelId: 200 },
    30: { itemId: "stream:C", legacyChannelId: 300 },
});
const blob = (values, name = "Main") => ({
    active: name,
    lists: { [name]: values },
    order: [name],
    v: 1,
});
function fixture() {
    const saved = new Map(),
        events = [];
    let readHook = null,
        writeHook = null;
    const w = { channels: rows(), console, p_pref: "a" };
    w.window = w;
    w.providerGetItem = (key) => {
        const value = saved.get(w.p_pref + ":" + key) ?? null;
        if (readHook) readHook(key);
        return value;
    };
    w.providerGetJson = (key, fallback) => {
        const value = w.providerGetItem(key);
        return value ? JSON.parse(value) : fallback;
    };
    w.providerSetItem = (key, value) => {
        events.push([w.p_pref, key, value]);
        saved.set(w.p_pref + ":" + key, value);
        if (writeHook) writeHook(key);
    };
    vm.createContext(w);
    require("./helpers/shared-core-runtime.cjs")(w, { vendorOnly: true });
    require("./helpers/private-runtime.cjs")(
        w,
        "src/provider/source-identity.ts"
    );
    vm.runInContext(code, w);
    function key() {
        return (
            w.p_pref + ":favoritesLibrary:" + w.__ottSourceIdentity.current(w)
        );
    }
    return {
        envelope(value) {
            saved.set(key(), JSON.stringify(value));
        },
        events,
        load() {
            w.loadFavoritesLists();
        },
        onRead(callback) {
            readHook = callback;
        },
        onWrite(callback) {
            writeHook = callback;
        },
        raw(name, value) {
            saved.set(w.p_pref + ":" + name, JSON.stringify(value));
        },
        read() {
            return JSON.parse(saved.get(key()));
        },
        saved,
        view() {
            return Array.from(w.favoritesArray);
        },
        w,
    };
}
let passed = 0;
function test(name, run) {
    run(fixture());
    passed++;
    console.log("PASS favorites references: " + name);
}
test("raw hash/current collision stays unresolved while canonical v1 targets the current ID", (f) => {
    f.w.channels = {
        10: { itemId: "A", legacyChannelId: 100 },
        100: { itemId: "B" },
    };
    f.raw("favoritesArray", [100]);
    f.load();
    assert.deepEqual(f.view(), []);
    assert.deepEqual(f.read().lists.lists.Favorites, [
        { ambiguous: true, legacyId: 100, origin: "raw" },
    ]);
    f.envelope({ lists: blob([100]), sourceId: "a", version: 1 });
    f.load();
    assert.deepEqual(f.view(), [100]);
    assert.equal(f.read().version, 2);
    assert.deepEqual(f.read().lists.lists.Main, [{ itemId: "B" }]);
});
test("codec follows observed transitive hashes and treats null, cycles and competing paths conservatively", (f) => {
    const codec = f.w.__ottChannelReferences.create(rows(), {
        1: 2,
        2: 100,
        4: null,
        5: 6,
        6: 5,
        10: 10,
    });
    assert.deepEqual(plain(codec.resolve(1, "raw")), { itemId: "stream:A" });
    assert.equal(codec.project(codec.resolve(1, "raw")), 10);
    for (const id of [4, 5, 6])
        assert.equal(codec.resolve(id, "raw").ambiguous, true);
    assert.deepEqual(plain(codec.resolve(10, "raw")), { itemId: "stream:A" });
    assert.deepEqual(plain(codec.resolve(1, "canonical")), {
        legacyId: 1,
        origin: "canonical",
    });
    const collision = f.w.__ottChannelReferences.create(
        { ...rows(), 2: { itemId: "other" } },
        { 1: 2, 2: 100 }
    );
    assert.equal(collision.resolve(1, "raw").ambiguous, true);
});
test("codec snapshot cannot drift when catalog or alias inputs mutate", (f) => {
    const channels = rows(),
        aliases = { 1: 100 };
    const codec = f.w.__ottChannelReferences.create(channels, aliases);
    channels[10].itemId = "replaced";
    aliases[1] = 200;
    assert.deepEqual(plain(codec.resolve(1, "raw")), { itemId: "stream:A" });
    assert.equal(codec.project({ itemId: "stream:A" }), 10);
});
test("ambiguous imported records never attach when only one competing channel later remains", (f) => {
    f.w.channels[100] = { itemId: "other" };
    f.raw("favoritesLists", blob([100]));
    f.load();
    delete f.w.channels[100];
    f.load();
    assert.deepEqual(f.view(), []);
    assert.equal(f.read().lists.lists.Main[0].ambiguous, true);
});
test("stable IDs survive renumbering and do not attach to another channel reusing a numeric ID", (f) => {
    f.raw("favoritesArray", [100, 200]);
    f.load();
    f.w.channels = {
        10: { itemId: "new stranger" },
        41: { itemId: "stream:A" },
        42: { itemId: "stream:B" },
    };
    f.load();
    assert.deepEqual(f.view(), [41, 42]);
    assert.deepEqual(f.read().lists.lists.Favorites, [
        { itemId: "stream:A" },
        { itemId: "stream:B" },
    ]);
});
test("missing references preserve relative order across save, rename and returning catalog", (f) => {
    f.raw("favoritesLists", blob([100, 200, 300]));
    f.load();
    delete f.w.channels[20];
    f.load();
    assert.deepEqual(f.view(), [10, 30]);
    assert(f.w.renameFavoritesList("Main", "Renamed"));
    assert(f.w.saveFavoritesLists());
    assert.deepEqual(f.read().lists.lists.Renamed, [
        { itemId: "stream:A" },
        { itemId: "stream:B" },
        { itemId: "stream:C" },
    ]);
    f.w.channels[99] = { itemId: "stream:B" };
    f.load();
    assert.deepEqual(f.view(), [10, 99, 30]);
});
test("visible removals and reordering retain only invisible references and list deletion removes them", (f) => {
    f.raw("favoritesLists", blob([100, 200, 300]));
    f.load();
    delete f.w.channels[20];
    f.load();
    f.w.favoritesArray.splice(0, 1);
    f.w.favoritesArray.push(10);
    f.w.saveFavoritesLists();
    assert.deepEqual(f.read().lists.lists.Main, [
        { itemId: "stream:B" },
        { itemId: "stream:C" },
        { itemId: "stream:A" },
    ]);
    f.w.favoritesArray.splice(1, 1);
    f.w.saveFavoritesLists();
    assert.deepEqual(f.read().lists.lists.Main, [
        { itemId: "stream:B" },
        { itemId: "stream:C" },
    ]);
    f.w.addFavoritesList("Keep");
    f.w.deleteFavoritesList("Main");
    f.w.saveFavoritesLists();
    assert.equal(f.read().lists.lists.Main, undefined);
    assert.deepEqual(f.read().lists.lists.Keep, []);
});
test("membership lookup retains duplicate selections, reference identity and invisible neighbours for prototype-like IDs", (f) => {
    f.w.channels = {
        10: { itemId: "__proto__" },
        20: { itemId: "constructor" },
        30: { itemId: "toString" },
    };
    const first = { itemId: "__proto__" };
    const second = { itemId: "constructor" };
    const leading = { itemId: "missing leading" };
    const middle = { itemId: "missing middle" };
    const trailing = { itemId: "missing trailing" };
    const prior = {
        bindings: { 10: first, 20: second },
        references: [
            leading,
            first,
            middle,
            second,
            { itemId: "toString" },
            first,
            trailing,
        ],
        view: [10, 20, 30, 10],
    };
    const selected = [20, 10, 20];
    const result = f.w.mergeFavoriteReferences(
        selected,
        prior,
        f.w.__ottChannelReferences.create(f.w.channels)
    );
    const expected = [middle, second, leading, first, second, trailing];
    assert.deepEqual(plain(result), expected);
    expected.forEach((reference, index) =>
        assert.equal(result[index], reference)
    );
    assert.deepEqual(selected, [20, 10, 20]);
    assert.equal(
        prior.references.length,
        7,
        "projection does not mutate prior references"
    );
});
test("saving a stale numeric projection cannot duplicate or redirect its missing stable binding", (f) => {
    f.raw("favoritesArray", [100]);
    f.load();
    f.w.channels = { 10: { itemId: "stranger" } };
    f.w.saveFavoritesLists();
    f.w.saveFavoritesLists();
    assert.deepEqual(f.read().lists.lists.Favorites, [{ itemId: "stream:A" }]);
    f.load();
    assert.deepEqual(f.view(), []);
    f.w.channels[77] = { itemId: "stream:A" };
    f.load();
    assert.deepEqual(f.view(), [77]);
});
test("unknown raw and canonical references resolve only under their recorded import policy", (f) => {
    f.envelope({
        lists: blob([
            { legacyId: 777, origin: "raw" },
            { legacyId: 778, origin: "canonical" },
        ]),
        sourceId: "a",
        version: 2,
    });
    f.load();
    assert.deepEqual(f.view(), []);
    f.w.saveFavoritesLists();
    f.w.channels[55] = { itemId: "returned raw", legacyChannelId: 777 };
    f.w.channels[56] = { itemId: "not canonical", legacyChannelId: 778 };
    f.load();
    assert.deepEqual(f.view(), [55]);
    f.w.channels[778] = { itemId: "canonical returned" };
    f.load();
    assert.deepEqual(f.view(), [55, 778]);
});
test("duplicate stable item identities stay invisible until the catalog becomes unambiguous", (f) => {
    f.envelope({
        lists: blob([{ itemId: "duplicate" }]),
        sourceId: "a",
        version: 2,
    });
    f.w.channels = { 10: { itemId: "duplicate" }, 20: { itemId: "duplicate" } };
    f.load();
    assert.deepEqual(f.view(), []);
    f.w.saveFavoritesLists();
    delete f.w.channels[20];
    f.load();
    assert.deepEqual(f.view(), [10]);
});
test("reference import reads the source-owned alias map without pre-mutating legacy data", (f) => {
    f.w.__ottLegacyChannelAliases = { 1: 2, 2: 100 };
    f.raw("favoritesArray", [1]);
    f.load();
    assert.deepEqual(f.view(), [10]);
    assert.equal(f.saved.get("a:favoritesArray"), "[1]");
});
test("account fingerprint and storage-accessor replacement reject stale saves", (f) => {
    let username = "first";
    f.w.__ottActiveProviderDriver = {
        credentials: () => ({ server: "server", username }),
    };
    f.raw("favoritesArray", [100]);
    f.load();
    const before = f.events.length;
    username = "second";
    assert.equal(f.w.saveFavoritesLists(), false);
    assert.equal(f.events.length, before);
    username = "first";
    f.w.providerSetItem = () => {
        throw Error("wrong storage");
    };
    assert.equal(f.w.saveFavoritesLists(), false);
    assert.equal(f.events.length, before);
});
for (const operation of ["load", "save"])
    test(
        "storage read reentry retires " +
            operation +
            " before replacement publication",
        (f) => {
            f.envelope({ lists: blob([10]), sourceId: "a", version: 1 });
            f.saved.set(
                "b:favoritesLibrary:b",
                JSON.stringify({ lists: blob([20]), sourceId: "b", version: 1 })
            );
            if (operation === "save") f.load();
            f.onRead((key) => {
                if (key !== "favoritesLibrary:a") return;
                f.onRead(null);
                f.w.p_pref = "b";
                f.load();
            });
            if (operation === "load") f.load();
            else assert.equal(f.w.saveFavoritesLists(), false);
            assert.deepEqual(f.view(), [20]);
            assert.deepEqual(f.read().lists.lists.Main, [
                { itemId: "stream:B" },
            ]);
        }
    );
test("write reentry cannot restore old references or refresh the old source", (f) => {
    f.envelope({ lists: blob([10]), sourceId: "a", version: 1 });
    f.load();
    f.saved.set(
        "b:favoritesLibrary:b",
        JSON.stringify({ lists: blob([20]), sourceId: "b", version: 1 })
    );
    f.w.favoritesArray.push(30);
    f.onWrite((key) => {
        if (key !== "favoritesLibrary:a") return;
        f.onWrite(null);
        f.w.p_pref = "b";
        f.load();
    });
    assert.equal(f.w.saveFavoritesLists(), false);
    assert.deepEqual(f.view(), [20]);
    f.w.saveFavoritesLists();
    assert.deepEqual(f.read().lists.lists.Main, [{ itemId: "stream:B" }]);
});
test("failed legacy reads cannot claim or shadow recoverable favorites", (f) => {
    f.raw("favoritesLists", blob([100, 200]));
    f.onRead((key) => {
        if (key === "favoritesLists") throw Error("temporary storage failure");
    });
    f.load();
    assert.deepEqual(f.view(), []);
    assert.equal(f.w.saveFavoritesLists(), false);
    assert.deepEqual(f.events, []);
    assert.equal(f.saved.has("a:favoritesLibrarySource"), false);
    assert.equal(f.saved.has("a:favoritesLibrary:a"), false);
    f.onRead(null);
    f.load();
    assert.deepEqual(f.view(), [10, 20]);
    assert.deepEqual(f.read().lists.lists.Main, [
        { itemId: "stream:A" },
        { itemId: "stream:B" },
    ]);
});
test("reloading migrated ambiguous and missing references makes no redundant storage writes", (f) => {
    f.w.channels[100] = { itemId: "other" };
    f.raw("favoritesLists", blob([100, 200, 999]));
    f.load();
    const before = f.events.length,
        text = f.saved.get("a:favoritesLibrary:a");
    f.load();
    f.load();
    f.w.saveFavoritesLists();
    assert.equal(f.events.length, before);
    assert.equal(f.saved.get("a:favoritesLibrary:a"), text);
});
test("future or malformed envelopes remain untouched and unwritable", (f) => {
    for (const value of [
        { lists: blob([10]), sourceId: "a", version: 99 },
        { lists: blob([10]), sourceId: "other", version: 2 },
    ]) {
        f.envelope(value);
        const before = [...f.saved];
        f.load();
        assert.equal(f.w.saveFavoritesLists(), false);
        assert.deepEqual([...f.saved], before);
    }
});
function language(w, name) {
    vm.runInContext(localizationRuntime(), w);
    vm.runInContext(
        fs.readFileSync(path.join(root, "locales", name + ".js"), "utf8"),
        w
    );
}
test("generated default names follow the live language without changing stable list keys", (f) => {
    language(f.w, "russian");
    f.raw("favoritesArray", [100]);
    f.load();
    assert.equal(f.read().defaultList, "Favorites");
    assert.equal(f.w.favoritesListLabel("Favorites"), "Избранные");
    assert.equal(f.w.getActiveFavoritesListName(), "Favorites");
    assert.deepEqual(f.view(), [10]);
    language(f.w, "english");
    assert.equal(f.w.favoritesListLabel("Favorites"), "Favorites");
    language(f.w, "russian");
    f.load();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Избранные");
    assert.deepEqual(f.view(), [10]);
});
test("unmarked legacy and scoped names remain user text, including literal Favorites", (f) => {
    language(f.w, "russian");
    for (const name of ["Favorites", "Избранные", "My favorites"]) {
        f.saved.clear();
        f.raw("favoritesLists", blob([100], name));
        f.load();
        assert.equal(f.w.favoritesListLabel(name), name);
        assert.equal(f.read().defaultList, undefined);
        f.load();
        assert.equal(f.w.favoritesListLabel(name), name);
        assert.deepEqual(f.view(), [10]);
        f.envelope({
            lists: blob([{ itemId: "stream:A" }], name),
            sourceId: "a",
            version: 2,
        });
        f.load();
        assert.equal(f.w.favoritesListLabel(name), name);
    }
});
test("rename and deletion retire default-name provenance without affecting custom names", (f) => {
    language(f.w, "russian");
    f.load();
    assert(f.w.renameFavoritesList("Favorites", "Mine"));
    assert(f.w.addFavoritesList("Favorites"));
    assert(f.w.saveFavoritesLists());
    f.load();
    assert.equal(f.read().defaultList, undefined);
    assert.equal(f.w.favoritesListLabel("Favorites"), "Favorites");
    f.saved.clear();
    f.load();
    assert(f.w.renameFavoritesList("Favorites", "Favorites"));
    assert(f.w.saveFavoritesLists());
    f.load();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Favorites");
    f.saved.clear();
    f.load();
    assert(f.w.addFavoritesList("Keep"));
    assert(f.w.deleteFavoritesList("Favorites"));
    assert(f.w.addFavoritesList("Favorites"));
    assert(f.w.saveFavoritesLists());
    f.load();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Favorites");
});
test("default provenance is source scoped and invalid markers do not overwrite stored libraries", (f) => {
    language(f.w, "russian");
    f.load();
    f.w.p_pref = "stale";
    assert.equal(f.w.renameFavoritesList("Favorites", "Favorites"), false);
    assert.equal(f.w.favoritesListLabel("Favorites"), "Избранные");
    f.w.p_pref = "a";
    f.w.p_pref = "b";
    f.raw("favoritesLists", blob([100], "Favorites"));
    f.load();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Favorites");
    f.w.p_pref = "a";
    f.load();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Избранные");
    for (const marker of [true, "Main", "Unknown"]) {
        f.envelope({
            defaultList: marker,
            lists: blob([]),
            sourceId: "a",
            version: 2,
        });
        const before = [...f.saved];
        f.load();
        assert.equal(f.w.saveFavoritesLists(), false);
        assert.equal(f.w.renameFavoritesList("Favorites", "Favorites"), false);
        assert.deepEqual([...f.saved], before);
    }
});
test("list manager renders the default label and unchanged rename leaves its provenance intact", (f) => {
    language(f.w, "russian");
    f.load();
    const source = ts.createSourceFile(
        "channels.ts",
        fs.readFileSync(path.join(root, "src/channels/index.ts"), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const node = source.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name?.text === "popFavLists"
    );
    const elements = {};
    Object.assign(f.w, {
        document: {
            getElementById: (id) =>
                elements[id] || (elements[id] = { style: {} }),
        },
        keys: { ENTER: 13, RETURN: 8 },
        refreshFavoritesViewIfActive() {},
        saveChannelsCats: () => f.w.saveFavoritesLists(),
        showEditKey() {},
        showShift() {},
    });
    vm.runInContext(
        ts.transpileModule(node.getText(source).replace(/^export /, ""), {
            compilerOptions: { target: ts.ScriptTarget.ES5 },
        }).outputText,
        f.w
    );
    f.w.popFavLists();
    assert.equal(f.w.listArray[0], "✓ Избранные");
    f.w.selIndex = 1;
    f.w.listKeyHandlerFn(13); // Manage lists
    assert.match(f.w.listArray[0], /^✓ Избранные/);
    f.w.selIndex = 0;
    f.w.listKeyHandlerFn(13); // Default list actions
    f.w.listKeyHandlerFn(13); // Rename
    assert.equal(f.w.editvar, "Избранные");
    f.w.setEdit();
    assert.equal(f.w.favoritesListLabel("Favorites"), "Избранные");
    assert.equal(f.read().defaultList, "Favorites");
});
test("merge preserves repeated neighbour buckets, identity and invisible tail", (f) => {
    const a = Object.freeze({ itemId: "A" });
    const equalA = Object.freeze({ itemId: "A" });
    const b = Object.freeze({ itemId: "B" });
    const unseen = Array.from({ length: 4 }, (_, index) =>
        Object.freeze({ ambiguous: true, legacyId: 100 + index, origin: "raw" })
    );
    const references = Object.freeze([
        unseen[0],
        a,
        unseen[1],
        b,
        unseen[2],
        equalA,
        unseen[3],
    ]);
    const view = Object.freeze([2, 1, 2]);
    const calls = [];
    const result = f.w.mergeFavoriteReferences(
        view,
        { bindings: Object.freeze({ 1: a, 2: b }), references },
        {
            project(reference) {
                calls.push(reference);
                return null;
            },
            resolve() {
                assert.fail("retained bindings must not be resolved again");
            },
        }
    );
    assert.deepEqual(Array.from(result), [
        unseen[1],
        b,
        unseen[0],
        unseen[2],
        a,
        b,
        unseen[3],
    ]);
    assert.deepEqual(calls, unseen);
    assert.notEqual(result, view);
    assert.equal(result[4], a);
    assert.notEqual(result[4], equalA);
});
test("large alternating invisible references do not recopy growing prefixes", (f) => {
    vm.runInContext(
        `var mergeCount = 1024, costView = [], costReferences = [], costBindings = Object.create(null);
        for (var i = 0; i < mergeCount; i++) {
            var reference = { itemId: 'item:' + i };
            costView.push(i);
            costReferences.push({ legacyId: i + 10000, origin: 'raw' }, reference);
            costBindings[i] = reference;
        }
        var mergeCopiedSlots = 0, originalMergeConcat = Array.prototype.concat;
        Array.prototype.concat = function () {
            mergeCopiedSlots += this.length;
            for (var i = 0; i < arguments.length; i++)
                mergeCopiedSlots += Array.isArray(arguments[i]) ? arguments[i].length : 1;
            return originalMergeConcat.apply(this, arguments);
        };
        var costResult;
        try {
            costResult = mergeFavoriteReferences(costView,
                { bindings: costBindings, references: costReferences },
                { project: function () { return null; }, resolve: function () { throw Error('unexpected resolve'); } });
        } finally { Array.prototype.concat = originalMergeConcat; }`,
        f.w
    );
    assert.equal(f.w.costResult.length, f.w.mergeCount * 2);
    for (let i = 0; i < f.w.costResult.length; i++)
        assert.equal(f.w.costResult[i], f.w.costReferences[i]);
    assert(
        f.w.mergeCopiedSlots <= f.w.mergeCount * 8,
        "merge must not copy an accumulated prefix once per neighbour"
    );
});
test("saving a large favorites list does not rescan references for every binding", (f) => {
    const count = 1024;
    f.w.channels = {};
    for (let id = 1; id <= count; id++)
        f.w.channels[id] = { itemId: "channel:" + id };
    f.raw(
        "favoritesLists",
        blob(Array.from({ length: count }, (_, i) => i + 1))
    );
    f.load();
    const before = f.read();
    vm.runInContext(
        `var bindingComparisons = 0, originalBindingIndexOf = Array.prototype.indexOf;
        Array.prototype.indexOf = function () {
            var at = originalBindingIndexOf.apply(this, arguments);
            bindingComparisons += at < 0 ? this.length : at + 1;
            return at;
        };`,
        f.w
    );
    try {
        assert.equal(f.w.saveFavoritesLists(), true);
    } finally {
        vm.runInContext(
            "Array.prototype.indexOf = originalBindingIndexOf;",
            f.w
        );
    }
    assert.deepEqual(f.read(), before);
    assert(
        f.w.bindingComparisons <= count * 10,
        "merged references already contain selected prior bindings"
    );
});
test("unmerged reference records still require exact prior object membership", (f) => {
    const original = { itemId: "same" },
        replacement = { itemId: "same" };
    const record = f.w.favoriteReferenceRecord(
        [1],
        [replacement],
        { project: () => 1 },
        { bindings: { 1: original } }
    );
    assert.equal(record.bindings[1], replacement);
});
console.log(
    "PASS " +
        passed +
        " favorites reference scenarios; ES5 codec and public numeric projections"
);
