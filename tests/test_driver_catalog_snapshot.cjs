"use strict";
// Execute only the two real snapshot functions, without provider/core fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/provider/drivers.ts");
const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
);
const names = ["emptyDriverCatalog", "driverCatalogSnapshot"];
const functions = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
);
assert.deepEqual(
    functions.map((node) => node.name.text),
    names,
    "Extract the actual snapshot and its only application dependency"
);
const compiled = ts.transpileModule(
    functions.map((node) => node.getText(source)).join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
        reportDiagnostics: true,
    }
);
assert.deepEqual(
    (compiled.diagnostics || []).filter(
        (entry) => entry.category === ts.DiagnosticCategory.Error
    ),
    []
);
acorn.parse(compiled.outputText, { ecmaVersion: 5 });

function fixture(setup) {
    const context = vm.createContext({});
    const run = (code) => vm.runInContext(code, context);
    run(compiled.outputText);
    run("var catalog = emptyDriverCatalog();");
    run(setup);
    return { context, prototype: run("Object.prototype"), run };
}
function dataProperty(object, key, value) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
function test(name, check) {
    check();
    console.log("PASS driver catalog snapshot: " + name);
}

test("nested state, groups and guide records are detached in both directions", () => {
    const f = fixture(`
        catalog.ids = [7];
        catalog.groupOrder = ["Live"];
        catalog.groups.Live = [7];
        catalog.channels[7] = {
            url: "original", category: { class: 0, name: "Live" },
            extra: { absent: undefined, nil: null, flag: false, zero: 0, nan: NaN },
            fn: function unchanged() {}
        };
        catalog.epg = { 7: [{ title: "Program", nested: { rating: 1 } }] };
        var first = driverCatalogSnapshot(catalog);
        var second = driverCatalogSnapshot(catalog);
    `);
    const { catalog, first, second } = f.context;
    assert.deepEqual(
        Object.keys(first.channels[7]),
        Object.keys(catalog.channels[7])
    );
    assert.equal(Object.getPrototypeOf(first.channels), f.prototype);
    assert.equal(Object.getPrototypeOf(first.channels[7]), f.prototype);
    for (const key of Object.keys(first.channels[7])) {
        dataProperty(first.channels[7], key, first.channels[7][key]);
    }
    assert.equal(first.channels[7].extra.absent, undefined);
    assert.equal(Object.hasOwn(first.channels[7].extra, "absent"), true);
    assert.equal(first.channels[7].extra.nil, null);
    assert.equal(first.channels[7].extra.flag, false);
    assert.equal(first.channels[7].extra.zero, 0);
    assert.equal(Number.isNaN(first.channels[7].extra.nan), true);
    assert.equal(first.channels[7].fn, catalog.channels[7].fn);
    first.channels[7].url = "view change";
    first.channels[7].category.name = "view group";
    first.epg[7][0].nested.rating = 99;
    first.groups.Live.push(8);
    first.ids.push(8);
    first.groupOrder.push("Other");
    assert.equal(catalog.channels[7].url, "original");
    assert.equal(catalog.channels[7].category.name, "Live");
    assert.equal(catalog.epg[7][0].nested.rating, 1);
    assert.deepEqual(Array.from(catalog.groups.Live), [7]);
    assert.deepEqual(Array.from(catalog.ids), [7]);
    assert.deepEqual(Array.from(catalog.groupOrder), ["Live"]);
    catalog.channels[7].category.class = 5;
    catalog.epg[7][0].title = "provider change";
    assert.equal(first.channels[7].category.class, 0);
    assert.equal(second.channels[7].category.name, "Live");
    assert.equal(second.epg[7][0].title, "Program");
});

test("prototype-like keys remain own data with unchanged object prototypes", () => {
    const f = fixture(`
        catalog.channels = JSON.parse('{"__proto__":{"nested":{"__proto__":{"safe":true}}},"constructor":{"value":2},"toString":"label","hasOwnProperty":false}');
        catalog.epg = JSON.parse('{"__proto__":[{"title":"Program"}]}');
        var first = driverCatalogSnapshot(catalog);
    `);
    const { catalog, first } = f.context;
    assert.deepEqual(
        Object.keys(first.channels),
        Object.keys(catalog.channels)
    );
    for (const key of [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
    ]) {
        dataProperty(first.channels, key, first.channels[key]);
    }
    dataProperty(
        first.channels.__proto__.nested,
        "__proto__",
        first.channels.__proto__.nested.__proto__
    );
    dataProperty(first.epg, "__proto__", first.epg.__proto__);
    assert.equal(Object.getPrototypeOf(first.channels), f.prototype);
    assert.equal(
        Object.getPrototypeOf(first.channels.__proto__.nested),
        f.prototype
    );
    assert.equal(Object.getPrototypeOf(first.epg), f.prototype);
    first.channels.__proto__.nested.__proto__.safe = false;
    first.epg.__proto__[0].title = "changed";
    assert.equal(catalog.channels.__proto__.nested.__proto__.safe, true);
    assert.equal(catalog.epg.__proto__[0].title, "Program");
    assert.equal(f.run("Object.prototype.safe"), undefined);
});

test("inherited accessors and nonwritable fields cannot intercept copied values", () => {
    const f = fixture(`
        var intercepted = 0;
        Object.defineProperty(Object.prototype, "guarded", {
            configurable: true,
            get: function () { intercepted++; return "inherited"; },
            set: function () { intercepted++; }
        });
        Object.defineProperty(Object.prototype, "fixed", {
            configurable: true, value: "inherited", writable: false
        });
        catalog.channels.one = { guarded: "own", fixed: "own" };
        Object.defineProperty(catalog.channels.one, "late", {
            enumerable: true,
            get: function () {
                Object.defineProperty(Object.prototype, "late", {
                    configurable: true, set: function () { intercepted++; }
                });
                return "own";
            }
        });
        var first;
        try { first = driverCatalogSnapshot(catalog); }
        finally {
            delete Object.prototype.guarded;
            delete Object.prototype.fixed;
            delete Object.prototype.late;
        }
    `);
    assert.equal(f.context.intercepted, 0);
    for (const key of ["guarded", "fixed", "late"]) {
        dataProperty(f.context.first.channels.one, key, "own");
    }
});

test("sparse arrays retain holes, explicit undefined and independent nested values", () => {
    const f = fixture(`
        var values = [];
        values.length = 4;
        values[1] = { number: 1 };
        values[3] = undefined;
        values.extra = "not an indexed element";
        catalog.channels.one = { values: values };
        catalog.epg = { one: values };
        var first = driverCatalogSnapshot(catalog);
    `);
    const { values, first } = f.context;
    const copy = first.channels.one.values;
    assert.equal(Array.isArray(copy), true);
    assert.equal(copy.length, 4);
    assert.equal(0 in copy, false);
    assert.equal(2 in copy, false);
    assert.equal(Object.hasOwn(copy, 3), true);
    assert.equal(copy[3], undefined);
    assert.equal(Object.hasOwn(copy, "extra"), false);
    assert.notEqual(copy, values);
    assert.notEqual(copy, first.epg.one);
    copy[1].number = 2;
    assert.equal(values[1].number, 1);
    assert.equal(first.epg.one[1].number, 1);
});

test("own getter reads keep their depth-first order and happen once", () => {
    const f = fixture(`
        var events = [];
        var nested = {};
        Object.defineProperty(nested, "leaf", {
            enumerable: true,
            get: function () { events.push("leaf"); return 3; }
        });
        Object.defineProperty(catalog.channels, "first", {
            enumerable: true,
            get: function () { events.push("first"); return nested; }
        });
        Object.defineProperty(catalog.channels, "second", {
            enumerable: true,
            get: function () { events.push("second"); return 4; }
        });
        var first = driverCatalogSnapshot(catalog);
    `);
    assert.deepEqual(Array.from(f.context.events), ["first", "leaf", "second"]);
    assert.deepEqual(Object.keys(f.context.first.channels), [
        "first",
        "second",
    ]);
    dataProperty(f.context.first.channels.first, "leaf", 3);
    dataProperty(f.context.first.channels, "second", 4);
});

test("a throwing child getter stops all later reads", () => {
    const f = fixture(`
        var events = [];
        var nested = {};
        Object.defineProperty(nested, "leaf", {
            enumerable: true,
            get: function () { events.push("leaf"); throw Error("snapshot stopped"); }
        });
        Object.defineProperty(catalog.channels, "first", {
            enumerable: true,
            get: function () { events.push("first"); return nested; }
        });
        Object.defineProperty(catalog.channels, "second", {
            enumerable: true,
            get: function () { events.push("second"); return 4; }
        });
    `);
    assert.throws(
        () => f.run("driverCatalogSnapshot(catalog)"),
        /snapshot stopped/
    );
    assert.deepEqual(Array.from(f.context.events), ["first", "leaf"]);
});

test("ordinary catalogs avoid descriptor allocation while inherited names stay data", () => {
    const f = fixture(`
        for (var i = 1; i <= 64; i++) {
            catalog.channels[i] = {
                ca: "", caso: "", category: { class: 0, name: "Live" },
                ch_id: i, channel_name: "Channel " + i, epg: String(i),
                groupId: "live", itemId: "channel:" + i,
                legacyChannelId: undefined, logo: "", rec: 0,
                tn: "Channel " + i, url: "stream:" + i
            };
            catalog.ids.push(i);
        }
        catalog.groupOrder = ["Live"];
        catalog.groups.Live = catalog.ids.slice();
        var nativeDefine = Object.defineProperty;
        var definitions = 0;
        Object.defineProperty = function (object, key, descriptor) {
            definitions++;
            return nativeDefine(object, key, descriptor);
        };
        var first, ordinaryDefinitions, protectedDefinitions;
        try {
            first = driverCatalogSnapshot(catalog);
            ordinaryDefinitions = definitions;
            catalog.channels = JSON.parse('{"__proto__":{"constructor":"data"}}');
            definitions = 0;
            var protectedSnapshot = driverCatalogSnapshot(catalog);
            protectedDefinitions = definitions;
        } finally { Object.defineProperty = nativeDefine; }
    `);
    assert.equal(f.context.ordinaryDefinitions, 0);
    assert.equal(f.context.first.ids.length, 64);
    assert.equal(f.context.first.channels[64].url, "stream:64");
    const protectedChannels = f.context.protectedSnapshot.channels;
    assert.equal(Object.getPrototypeOf(protectedChannels), f.prototype);
    dataProperty(protectedChannels, "__proto__", protectedChannels.__proto__);
    dataProperty(protectedChannels.__proto__, "constructor", "data");
    console.log(
        "Snapshot defineProperty observations: ordinary=" +
            f.context.ordinaryDefinitions +
            ", inherited names=" +
            f.context.protectedDefinitions
    );
});
