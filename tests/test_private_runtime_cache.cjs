const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const helper = path.join(__dirname, "helpers/private-runtime.cjs");
const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ottplay-private-cache-")
);
let passed = 0;

function loader() {
    const compilations = [];
    const module = { exports: {} };
    // Count real TypeScript compilation without adding a production cache API.
    vm.runInNewContext(fs.readFileSync(helper, "utf8"), {
        __dirname: path.dirname(helper),
        module,
        require(name) {
            if (name !== "typescript") return require(name);
            return {
                ...ts,
                transpileModule(source, options) {
                    compilations.push({ options, source });
                    return ts.transpileModule(source, options);
                },
            };
        },
    });
    return { compilations, run: module.exports };
}

function context() {
    const host = vm.createContext({});
    host.window = host;
    return host;
}

function test(name, run) {
    run();
    passed++;
    console.log("PASS private runtime cache: " + name);
}

const state =
    'window.value = "A"; window.items = []; window.make = function () { return {}; }; window.runs = (window.runs || 0) + 1;';

try {
    test("cached code initializes independent realms and reruns in the same realm", () => {
        const file = path.join(directory, "state.ts");
        fs.writeFileSync(file, state);
        const { compilations, run } = loader();
        const first = context();
        const second = context();
        run(first, file);
        const originalItems = first.items;
        const originalMake = first.make;
        first.items.push("only first");
        run(second, file);
        assert.equal(second.items.length, 0);
        assert.notEqual(first.make, second.make);
        assert.notEqual(
            Object.getPrototypeOf(first.items),
            Object.getPrototypeOf(second.items)
        );
        assert.notEqual(
            Object.getPrototypeOf(first.make()),
            Object.getPrototypeOf(second.make())
        );
        run(first, file);
        assert.equal(first.runs, 2);
        assert.equal(second.runs, 1);
        assert.equal(first.items.length, 0);
        assert.notEqual(first.items, originalItems);
        assert.notEqual(first.make, originalMake);
        assert.equal(
            compilations.length,
            1,
            "Reuse code, never initialized state"
        );
        assert.equal(
            compilations[0].options.compilerOptions.module,
            ts.ModuleKind.ES2015
        );
        assert.equal(
            compilations[0].options.compilerOptions.target,
            ts.ScriptTarget.ES5
        );
    });

    test("same-length and same-mtime edits replace only that file's cached code", () => {
        const file = path.join(directory, "edited.ts");
        const other = path.join(directory, "other.ts");
        const fixed = new Date("2026-01-01T00:00:00Z");
        const changed = state.replace('"A"', '"B"');
        assert.equal(Buffer.byteLength(state), Buffer.byteLength(changed));
        fs.writeFileSync(file, state);
        fs.utimesSync(file, fixed, fixed);
        fs.writeFileSync(other, state);
        const { compilations, run } = loader();
        run(context(), file);
        run(context(), other);
        assert.equal(
            compilations.length,
            2,
            "Distinct filenames retain distinct records"
        );
        const before = fs.statSync(file);
        fs.writeFileSync(file, changed);
        fs.utimesSync(file, fixed, fixed);
        const after = fs.statSync(file);
        assert.equal(before.size, after.size);
        assert.equal(before.mtimeMs, after.mtimeMs);
        const modified = context();
        run(modified, file);
        assert.equal(modified.value, "B");
        const unaffected = context();
        run(unaffected, other);
        assert.equal(unaffected.value, "A");
        assert.equal(compilations.length, 3);
        // Retain the latest version per filename, not every historical source.
        fs.writeFileSync(file, state);
        run(context(), file);
        assert.equal(compilations.length, 4);
    });

    test("unreadable or invalid changed sources never execute previous cached code", () => {
        const file = path.join(directory, "failure.ts");
        fs.writeFileSync(file, state);
        const { run } = loader();
        const host = context();
        run(host, file);
        fs.unlinkSync(file);
        assert.throws(() => run(host, file), { code: "ENOENT" });
        assert.equal(host.runs, 1);
        fs.writeFileSync(file, "window.runs = window.runs + ;");
        for (let attempt = 0; attempt < 2; attempt++) {
            assert.throws(
                () => run(host, file),
                (error) => {
                    assert.equal(error.name, "SyntaxError");
                    assert(
                        error.stack.includes(file),
                        "Keep the source filename in failures"
                    );
                    return true;
                }
            );
            assert.equal(host.runs, 1);
        }
        fs.writeFileSync(file, state.replace('"A"', '"C"'));
        run(host, file);
        assert.equal(host.value, "C");
        assert.equal(host.runs, 2);
    });

    test("cached runtime failures rerun and preserve each source filename", () => {
        const files = ["throw-one.ts", "throw-two.ts"].map((name) =>
            path.join(directory, name)
        );
        const source =
            'window.runs = (window.runs || 0) + 1; throw new Error("fixture failure");';
        for (const file of files) fs.writeFileSync(file, source);
        const { compilations, run } = loader();
        const host = context();
        for (const [index, file] of [files[0], files[0], files[1]].entries()) {
            assert.throws(
                () => run(host, file),
                (error) => {
                    assert.equal(error.message, "fixture failure");
                    assert(error.stack.includes(file));
                    return true;
                }
            );
            assert.equal(host.runs, index + 1);
        }
        const fresh = context();
        assert.throws(() => run(fresh, files[0]), /fixture failure/);
        assert.equal(fresh.runs, 1);
        assert.equal(compilations.length, 2);
    });
} finally {
    fs.rmSync(directory, { force: true, recursive: true });
}
console.log("PASS " + passed + " private runtime cache contracts");
