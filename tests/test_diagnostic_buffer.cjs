const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const acorn = require("acorn");
const source = ts.transpileModule(
    fs.readFileSync(
        require("node:path").join(
            __dirname,
            "../src/plugins/diagnostic-buffer.ts"
        ),
        "utf8"
    ),
    {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
acorn.parse(source, { ecmaVersion: 5 });
const context = { exports: {} };
vm.runInNewContext(source, context);
const make = context.exports.createDiagnosticBuffer;
const options = { maxBytes: 100, maxEntries: 3, maxEventBytes: 50 };
for (const bad of [
    null,
    {},
    { ...options, maxEntries: 0 },
    { ...options, maxBytes: Infinity },
    { ...options, maxEventBytes: 101 },
    { ...options, maxEntries: 801 },
    { ...options, maxBytes: 524289 },
    { ...options, maxEventBytes: 32769 },
    { ...options, maxBytes: "100" },
])
    assert.throws(() => make(bad));
const buffer = make(options);
for (const bad of [
    "",
    null,
    "[]",
    "null",
    "0",
    "bad",
    '"value"',
    '{"a":' + " ".repeat(100) + "1}",
])
    assert.equal(buffer.append(bad), null);
assert.equal(buffer.stats().droppedCount, 8);
for (let i = 0; i < 5; i++)
    assert.equal(buffer.append(JSON.stringify({ i })), i + 1);
let page = buffer.read(0, 100, 1000);
assert.deepEqual(
    Array.from(page.entries, (e) => e.sequence),
    [3, 4, 5]
);
assert.equal(page.gap, true);
assert.equal(page.oldestSequence, 3);
assert.equal(page.latestSequence, 5);
assert.equal(page.nextSequence, 5);
assert.equal(page.droppedCount, 10);
page.entries[0].payload = "mutated";
assert.equal(buffer.read(2, 1, 100).entries[0].payload, '{"i":2}');
assert.equal(buffer.read(2, 1, 100).gap, false);
for (const [cursor, limit, bytes] of [
    [-1, 1, 1],
    [1.5, 1, 1],
    [Infinity, 1, 1],
    ["1", 1, 1],
    [0, -1, 1],
    [0, 0.1, 1],
    [0, 1, NaN],
    [0, 1, 9007199254740992],
])
    assert.throws(() => buffer.read(cursor, limit, bytes));
assert.equal(buffer.read(0, 0, 100).nextSequence, 0);
assert.equal(buffer.read(2, 3, 0).nextSequence, 2);
assert.equal(buffer.read(100, 3, 100).gap, false);
assert.equal(buffer.read(100, 3, 100).nextSequence, 100);
buffer.clear();
assert.equal(buffer.stats().bytes, 0);
assert.equal(buffer.stats().entries, 0);
assert.equal(buffer.stats().latestSequence, 5);
assert.equal(buffer.stats().droppedCount, 13);
assert.equal(buffer.read(0, 3, 100).gap, true);
assert.equal(buffer.read(5, 3, 100).gap, false);
assert.equal(buffer.append("{}"), 6);
// Accepted IDs stay consecutive through rejection, eviction and clear. Cursors
// before, within and beyond the retained window must return the same FIFO page.
const cursorBuffer = make({ maxBytes: 12, maxEntries: 3, maxEventBytes: 8 });
for (let i = 0; i < 4; i++) {
    assert.equal(cursorBuffer.append("{}"), i + 1);
    assert.equal(cursorBuffer.append("[]"), null);
}
for (const [cursor, expected, gap] of [
    [0, [2, 3, 4], true],
    [1, [2, 3, 4], false],
    [2, [3, 4], false],
    [3, [4], false],
    [4, [], false],
    [5, [], false],
    [Number.MAX_SAFE_INTEGER, [], false],
]) {
    const result = cursorBuffer.read(cursor, 3, 12);
    assert.deepEqual(
        Array.from(result.entries, (e) => e.sequence),
        expected
    );
    assert.equal(result.gap, gap);
    assert.equal(result.oldestSequence, 2);
    assert.equal(result.nextSequence, expected.at(-1) ?? cursor);
}
assert.equal(cursorBuffer.read(2, 1, 12).nextSequence, 3);
assert.equal(cursorBuffer.read(2, 3, 1).nextSequence, 2);
assert.equal(cursorBuffer.read(2, 0, 12).nextSequence, 2);
assert.equal(cursorBuffer.append('{"a":1}'), 5);
assert.equal(cursorBuffer.append('{"a":2}'), 6);
assert.deepEqual(
    Array.from(cursorBuffer.read(0, 3, 12).entries, (e) => e.sequence),
    [6]
);
assert.equal(cursorBuffer.read(5, 3, 12).gap, false);
assert.equal(cursorBuffer.read(4, 3, 12).gap, true);
cursorBuffer.clear();
assert.equal(
    cursorBuffer.read(Number.MAX_SAFE_INTEGER, 3, 12).nextSequence,
    Number.MAX_SAFE_INTEGER
);
assert.equal(cursorBuffer.append("{}"), 7);
assert.equal(cursorBuffer.append("{}"), 8);
assert.deepEqual(
    Array.from(cursorBuffer.read(7, 3, 12).entries, (e) => e.sequence),
    [8]
);
assert.equal(cursorBuffer.read(6, 3, 12).gap, false);
assert.equal(cursorBuffer.read(5, 3, 12).gap, true);
// Node's UTF-8 encoder is an independent oracle, including lone surrogates.
for (const text of [
    "ascii",
    "Я漢字😀",
    "\ud800",
    "\udc00",
    "\ud800x",
    "\ud800\udc00",
    "\udbff\udfff",
]) {
    const payload = '{"text":"' + text + '"}';
    const exact = Buffer.byteLength(payload, "utf8");
    const b = make({
        maxBytes: exact * 2,
        maxEntries: 2,
        maxEventBytes: exact,
    });
    assert.equal(b.append(payload), 1);
    assert.equal(b.stats().bytes, exact);
    assert.equal(b.read(0, 2, exact - 1).entries.length, 0);
    assert.equal(b.read(0, 2, exact).entries[0].bytes, exact);
    assert.equal(b.append(payload), 2);
    assert.equal(b.append(payload), 3);
    assert.equal(b.stats().bytes, exact * 2);
    assert.equal(b.read(0, 2, exact * 2).gap, true);
}
// Byte pressure evicts complete entries and releases all accounting on clear.
const bounded = make({ maxBytes: 64, maxEntries: 800, maxEventBytes: 32 });
for (let i = 0; i < 10000; i++) {
    bounded.append(JSON.stringify({ n: i }));
    assert(bounded.stats().bytes <= 64);
    assert(bounded.stats().entries <= 9);
}
assert.equal(bounded.stats().latestSequence, 10000);
bounded.clear();
assert.equal(bounded.stats().bytes, 0);
assert.equal(bounded.stats().droppedCount, 10000);
console.log(
    "PASS diagnostic buffer: UTF-8, byte/count bounds, invalid input, FIFO gaps, independent pages, monotonic sequence and cleanup"
);
