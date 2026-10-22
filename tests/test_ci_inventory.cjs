const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("../scripts/check-test-inventory.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-ci-inventory-"));
function write(file, content) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}
try {
    write("tests/test_parent.cjs", 'require("./test_child.cjs");\n');
    write("tests/test_child.cjs", "// executed through the parent\n");
    write("tests/test_native.py", "# platform-specific behavioral harness\n");
    write("tests/test_forgotten.py", "# newly introduced suite\n");
    write(
        "tests/ci-inventory.json",
        JSON.stringify({
            excluded: {},
            requiredVariants: {
                "tests/test_native.py": [
                    ["--platform", "android"],
                    ["--platform", "ios"],
                ],
            },
        })
    );
    write(
        "package.json",
        JSON.stringify({
            scripts: {
                parent: "node tests/test_parent.cjs",
                test: "npm run parent",
                unused: "python3 tests/test_forgotten.py",
            },
        })
    );
    write(
        ".github/workflows/ci.yml",
        "on: pull_request\njobs:\n  test:\n    steps:\n      - run: |\n          npm test\n          # python3 tests/test_forgotten.py\n          python3 tests/test_native.py --check-mirrors-only\n"
    );
    let result = inspect(root);
    assert(!result.errors.some((error) => error.includes("test_child")));
    assert(
        result.errors.some(
            (error) =>
                error.includes("unreachable") &&
                error.includes("test_forgotten")
        )
    );
    assert.equal(
        result.errors.filter((error) => error.includes("Missing CI variant"))
            .length,
        2
    );
    // Merely reading a test or mentioning an invocation in a string is not executing it.
    write(
        "tests/test_parent.cjs",
        'require("node:fs").readFileSync("./test_child.cjs");\nconst example = "require(\\\"./test_child.cjs\\\")";\n'
    );
    assert(
        inspect(root).errors.some(
            (error) =>
                error.includes("unreachable") && error.includes("test_child")
        )
    );
    write("tests/test_parent.cjs", 'require("./test_child.cjs");\n');
    write(
        ".github/workflows/ci.yml",
        "on: pull_request\njobs:\n  test:\n    steps:\n      - run: |\n          npm test\n          python3 tests/test_native.py --platform android\n          python3 tests/test_native.py --platform ios\n          python3 -m unittest discover -s tests -p 'test_forgotten.py' -v\n"
    );
    write(
        ".github/workflows/unused.yml",
        "on: workflow_call\njobs:\n  orphan:\n    steps:\n      - run: node tests/test_orphan.cjs\n"
    );
    write(
        "tests/test_orphan.cjs",
        "// unreachable reusable workflow is not CI coverage\n"
    );
    assert(inspect(root).errors.some((error) => error.includes("test_orphan")));
    fs.unlinkSync(path.join(root, "tests/test_orphan.cjs"));
    result = inspect(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.reached, 4);
    write(
        "tests/browser/device.spec.cjs",
        "// browser boot and keyboard scenarios\n"
    );
    assert(
        inspect(root).errors.some((error) => error.includes("device.spec.cjs"))
    );
    const workflowPath = path.join(root, ".github/workflows/ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    write(
        ".github/workflows/ci.yml",
        workflow + "          npx playwright install chromium\n"
    );
    assert(
        inspect(root).errors.some((error) => error.includes("device.spec.cjs"))
    );
    for (const runner of ["playwright", "npx playwright"]) {
        write(
            ".github/workflows/ci.yml",
            workflow +
                `          ${runner} test --list tests/browser/device.spec.cjs\n`
        );
        assert(
            inspect(root).errors.some((error) =>
                error.includes("device.spec.cjs")
            )
        );
        write(
            ".github/workflows/ci.yml",
            workflow +
                `          ${runner} test tests/browser/device.spec.cjs\n`
        );
        assert.deepEqual(inspect(root).errors, []);
    }
    write(
        "tests/python-suites.json",
        JSON.stringify({ portable: [["tests/test_python_suite.py"]] })
    );
    write("tests/test_python_suite.py", "# registered portable test\n");
    write(
        ".github/workflows/ci.yml",
        workflow + "          python3 scripts/test-python.py --help\n"
    );
    assert(
        inspect(root).errors.some((error) =>
            error.includes("test_python_suite.py")
        )
    );
    write(
        ".github/workflows/ci.yml",
        workflow +
            "          python3 scripts/test-python.py --profile portable\n          playwright test tests/browser/device.spec.cjs\n"
    );
    assert.deepEqual(inspect(root).errors, []);
    write("tests/test_new.cjs", "// uncovered test must fail the next PR\n");
    assert(inspect(root).errors.some((error) => error.includes("test_new")));
    write(
        "tests/ci-inventory.json",
        JSON.stringify({
            excluded: {
                "tests/test_new.cjs":
                    "Manual physical-device fixture requires connected TV firmware",
            },
        })
    );
    assert.deepEqual(inspect(root).errors, []);
    write(
        "tests/ci-inventory.json",
        JSON.stringify({ excluded: { "tests/test_new.cjs": "" } })
    );
    assert(
        inspect(root).errors.some((error) => error.includes("concrete reason"))
    );
    console.log(
        "PASS CI inventory: npm reachability, AST child tests, comments/source reads, required platforms, discovery and explicit exclusions"
    );
} finally {
    fs.rmSync(root, { force: true, recursive: true });
}
