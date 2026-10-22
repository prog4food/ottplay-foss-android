/* Actual standalone media source only: no provider/player/core fixture. */
const assert = require("node:assert/strict");
const vm = require("node:vm");
const privateRuntime = require("./helpers/private-runtime.cjs");

function fixture(setup = "") {
    const context = vm.createContext({});
    context.window = context;
    privateRuntime(context, "src/media/library.ts");
    const run = (source) => vm.runInContext(source, context);
    run("var copy = window.__ottMediaLibrary.copy;");
    if (setup) run(setup);
    return { context, run };
}
function dataProperty(object, key, value) {
    assert.deepEqual(Object.getOwnPropertyDescriptor(object, key), {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
    });
}
let passed = 0;
function test(name, check) {
    check();
    passed++;
    console.log("PASS media library copy: " + name);
}

test("primitives and functions retain exact values and identity", () => {
    const f = fixture(`
        var values = [null, undefined, false, true, 0, -0, NaN, Infinity,
            "", "<>&", function unchanged() {}, Symbol("tag"), BigInt(1)];
        var copied = values.map(function (value) { return copy(value); });
    `);
    f.context.values.forEach((value, index) => {
        assert(Object.is(f.context.copied[index], value));
    });
});
test("nested objects detach in both directions and shared siblings clone separately", () => {
    const f = fixture(`
        var shared = { nested: { title: "original" } };
        var input = { left: shared, right: shared, rows: [shared] };
        var first = copy(input), second = copy(input);
    `);
    const { input, first, second } = f.context;
    assert.notEqual(first, input);
    assert.notEqual(first.left, input.left);
    assert.notEqual(first.left, first.right);
    assert.notEqual(first.left, first.rows[0]);
    assert.notEqual(first.left.nested, second.left.nested);
    first.left.nested.title = "copy";
    assert.equal(input.left.nested.title, "original");
    assert.equal(first.right.nested.title, "original");
    input.left.nested.title = "source";
    assert.equal(second.rows[0].nested.title, "original");
});
test("only ancestor cycles become present undefined data properties", () => {
    const f = fixture(`
        var input = { child: {} };
        input.self = input;
        input.child.parent = input;
        input.child.self = input.child;
        var copied = copy(input);
    `);
    const { copied } = f.context;
    dataProperty(copied, "self", undefined);
    dataProperty(copied.child, "parent", undefined);
    dataProperty(copied.child, "self", undefined);
});
test("caller seen remains unchanged during getters and can exclude a known ancestor", () => {
    const f = fixture(`
        var ancestor = {}, seen = Object.freeze([ancestor]);
        var observedLength = -1;
        var input = { blocked: ancestor };
        Object.defineProperty(input, "probe", { enumerable: true, get: function () {
            observedLength = seen.length;
            return { nested: 7 };
        }});
        var copied = copy(input, seen), excluded = copy(ancestor, seen);
    `);
    const { seen, ancestor, copied } = f.context;
    assert.equal(f.context.observedLength, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], ancestor);
    assert.equal(f.context.excluded, undefined);
    dataProperty(copied, "blocked", undefined);
    assert.equal(copied.probe.nested, 7);
});
test("sparse arrays retain present keys but do not preserve trailing holes", () => {
    const f = fixture(`
        var holes = new Array(4), input = new Array(6);
        input[1] = undefined;
        input.extra = { title: "extra" };
        input["01"] = "not an array index";
        var copiedHoles = copy(holes), copied = copy(input);
    `);
    const { input, copied, copiedHoles } = f.context;
    assert.equal(copiedHoles.length, 0);
    assert.equal(copied.length, 2);
    assert.equal(0 in copied, false);
    dataProperty(copied, "1", undefined);
    assert.equal(copied["01"], "not an array index");
    assert.notEqual(copied.extra, input.extra);
    assert.equal(copied.extra.title, "extra");
    assert.equal(input.length, 6);
    assert.equal(0 in input, false);
});
test("own special names are data fields and inherited/nonenumerable fields stay absent", () => {
    const f = fixture(`
        var inheritedReads = 0;
        var prototype = {};
        Object.defineProperty(prototype, "inherited", { enumerable: true, get: function () {
            inheritedReads++; return "inherited";
        }});
        var input = Object.create(prototype);
        Object.defineProperty(input, "hidden", { value: 9 });
        ["__proto__", "constructor", "toString", "hasOwnProperty"].forEach(function (key) {
            Object.defineProperty(input, key, { enumerable: true, value: { name: key } });
        });
        var copied = copy(input);
    `);
    const { input, copied } = f.context;
    assert.equal(f.context.inheritedReads, 0);
    assert.equal(Object.getPrototypeOf(copied), f.run("Object.prototype"));
    assert.equal(Object.hasOwn(copied, "hidden"), false);
    assert.equal(Object.hasOwn(copied, "inherited"), false);
    for (const key of [
        "__proto__",
        "constructor",
        "toString",
        "hasOwnProperty",
    ]) {
        assert.notEqual(copied[key], input[key]);
        assert.equal(copied[key].name, key);
        dataProperty(copied, key, copied[key]);
    }
});
test("accessors and readonly properties become writable data fields", () => {
    const f = fixture(`
        var reads = 0, writes = 0, input = {};
        Object.defineProperty(input, "accessor", { enumerable: true,
            get: function () { reads++; return { title: "nested" }; },
            set: function () { writes++; }
        });
        Object.defineProperty(input, "readonly", { enumerable: true, value: 3 });
        var copied = copy(input);
    `);
    const { copied } = f.context;
    assert.equal(f.context.reads, 1);
    dataProperty(copied, "accessor", copied.accessor);
    dataProperty(copied, "readonly", 3);
    copied.accessor = "changed";
    copied.readonly = 4;
    assert.equal(f.context.writes, 0);
    assert.equal(f.context.input.readonly, 3);
});
test("keys are captured before getters; deleted keys can resolve through a new prototype", () => {
    const f = fixture(`
        var events = [], input = {};
        Object.defineProperty(input, "first", { enumerable: true, get: function () {
            events.push("first");
            input.added = "not in initial keys";
            delete input.later;
            var prototype = {};
            Object.defineProperty(prototype, "later", { get: function () {
                events.push("inherited later"); return "replacement";
            }});
            Object.setPrototypeOf(input, prototype);
            return "first value";
        }});
        input.later = "removed";
        Object.defineProperty(input, "last", { enumerable: true, get: function () {
            events.push("last"); return "last value";
        }});
        var copied = copy(input);
    `);
    assert.deepEqual(Array.from(f.context.events), [
        "first",
        "inherited later",
        "last",
    ]);
    assert.deepEqual(Object.keys(f.context.copied), ["first", "later", "last"]);
    assert.equal(f.context.copied.later, "replacement");
    assert.equal(Object.hasOwn(f.context.copied, "added"), false);
});
test("getter errors retain identity, stop later reads and leave supplied seen intact", () => {
    const f = fixture(`
        var error = new Error("getter failed"), caught, events = [];
        var ancestor = {}, seen = Object.freeze([ancestor]), input = {};
        Object.defineProperty(input, "first", { enumerable: true, get: function () {
            events.push("first");
            var child = {};
            Object.defineProperty(child, "fail", { enumerable: true, get: function () {
                events.push("nested"); throw error;
            }});
            return child;
        }});
        Object.defineProperty(input, "later", { enumerable: true, get: function () {
            events.push("later"); return 9;
        }});
        try { copy(input, seen); } catch (failure) { caught = failure; }
    `);
    assert.equal(f.context.caught, f.context.error);
    assert.deepEqual(Array.from(f.context.events), ["first", "nested"]);
    assert.equal(f.context.seen.length, 1);
    assert.equal(f.context.seen[0], f.context.ancestor);
});
for (const target of [
    "object setter",
    "object getter",
    "object readonly",
    "array setter",
    "array getter",
    "array readonly",
]) {
    test(
        "nested getter cannot redirect the outer write through an inherited " +
            target,
        () => {
            const array = target.startsWith("array"),
                setter = target.endsWith("setter");
            const f = fixture(`
            var intercepted = 0, child = {}, copied;
            var input = ${array ? "[child]" : "{ child: child }"};
            var prototype = ${array ? "Array.prototype" : "Object.prototype"};
            var key = ${array ? '"0"' : '"child"'};
            Object.defineProperty(child, "activate", { enumerable: true, get: function () {
                Object.defineProperty(prototype, key, {
                    configurable: true,
                    ${setter ? "set: function () { intercepted++; }" : target.endsWith("getter") ? "get: function () { intercepted++; return undefined; }" : "value: undefined, writable: false"}
                });
                return "activated";
            }});
            try { copied = copy(input); }
            finally { delete prototype[key]; }
        `);
            const key = array ? "0" : "child",
                copied = f.context.copied;
            assert.equal(f.context.intercepted, 0);
            assert.equal(copied[key].activate, "activated");
            dataProperty(copied, key, copied[key]);
            if (array) assert.equal(copied.length, 1);
        }
    );
}
test("show/current snapshots exclude ancestor items; public all snapshots include and detach them", () => {
    const f = fixture(`
        var reads = { parent: 0, child: 0 }, rendered;
        function item(id) {
            var payload = {};
            Object.defineProperty(payload, "probe", { enumerable: true, get: function () {
                reads[id]++; return { title: id };
            }});
            return { title: id, payload: payload, ref: { itemId: id, sourceId: "source" } };
        }
        var parent = item("parent"), child = item("child");
        var library = window.__ottMediaLibrary.create({
            describe: function (records) { return records; },
            items: function () { return []; },
            load: function (route, done) { done([route.title === "parent" ? parent : child]); },
            render: function (view) { rendered = view; }
        });
        library.open({ kind: "catalog", title: "parent" });
        library.open({ kind: "catalog", title: "child" });
        reads.parent = 0; reads.child = 0;
        library.show();
        var current = library.snapshot("current");
        var none = library.snapshot("none");
    `);
    const { reads, rendered, current, none } = f.context;
    assert.equal(reads.parent, 0);
    assert.equal(reads.child, 2);
    assert.equal(rendered.frames[0].items.length, 0);
    assert.equal(current.frames[0].route.title, "parent");
    assert.equal(current.frames[0].items.length, 0);
    assert.equal(none.frame.items.length, 0);
    assert.equal(current.frame, current.frames[1]);
    f.run('var all = library.snapshot("all"), implicit = library.snapshot();');
    assert.equal(reads.parent, 2);
    assert.equal(reads.child, 4);
    assert.equal(
        f.context.all.frames[0].items[0].payload.probe.title,
        "parent"
    );
    f.context.all.frames[0].items[0].payload.probe.title = "external";
    f.context.implicit.frame.items[0].ref.itemId = "external";
    f.run(
        "var catalog = library.catalog(), selected = library.select(0), fresh = library.snapshot();"
    );
    assert.equal(
        f.context.fresh.frames[0].items[0].payload.probe.title,
        "parent"
    );
    assert.equal(f.context.fresh.frame.items[0].ref.itemId, "child");
    assert.notEqual(f.context.catalog[0], f.context.child);
    assert.notEqual(f.context.selected.payload, f.context.child.payload);
});
test("ordinary payload keys avoid descriptor calls while protected names stay data fields", () => {
    const f = fixture(`
        var input = {
            title: "Film", ref: { itemId: "item", sourceId: "provider" },
            payload: {
                url: "https://fixture.invalid/video",
                metadata: { year: 2026, genre: "Drama" },
                variants: [{ url: "one" }, { url: "two" }]
            }
        };
        var protectedInput = {};
        ["__proto__", "constructor", "toString"].forEach(function (key) {
            Object.defineProperty(protectedInput, key, { enumerable: true, value: key });
        });
        var originalDefine = Object.defineProperty, calls = 0;
        var copied, protectedCopy, ordinaryCalls, protectedCalls;
        Object.defineProperty = function (object, key, descriptor) {
            calls++;
            return originalDefine(object, key, descriptor);
        };
        try {
            copied = copy(input);
            ordinaryCalls = calls;
            calls = 0;
            protectedCopy = copy(protectedInput);
            protectedCalls = calls;
        } finally {
            Object.defineProperty = originalDefine;
        }
    `);
    const { input, copied, protectedCopy } = f.context;
    assert.equal(JSON.stringify(copied), JSON.stringify(input));
    assert.notEqual(copied.payload.metadata, input.payload.metadata);
    assert.notEqual(copied.payload.variants[0], input.payload.variants[0]);
    assert.equal(
        Object.getPrototypeOf(protectedCopy),
        f.run("Object.prototype")
    );
    for (const key of ["__proto__", "constructor", "toString"])
        dataProperty(protectedCopy, key, key);
    assert.equal(
        f.context.ordinaryCalls,
        0,
        "ordinary media fields need no descriptor calls"
    );
    assert.equal(
        f.context.protectedCalls,
        3,
        "protected names retain safe own-property writes"
    );
});
console.log("PASS " + passed + " media library copy scenarios");
