#!/usr/bin/env node
// Audit executable workflow steps, npm script edges and JS require/import edges.
// A filename appearing in a comment, source read or unused npm script is not coverage.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const YAML = require("yaml");

function filesBelow(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const file = path.join(directory, entry.name);
            return entry.isDirectory()
                ? ["target", "__pycache__", "node_modules"].includes(entry.name)
                    ? []
                    : filesBelow(file)
                : [file];
        });
}

// Preserve quoted arguments and command boundaries; discard shell comments.
function commands(source) {
    const result = [];
    let command = [],
        word = "",
        quote = "",
        started = false;
    const flushWord = () => {
        if (started) command.push(word);
        word = "";
        started = false;
    };
    const flushCommand = () => {
        flushWord();
        if (command.length) result.push(command);
        command = [];
    };
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === "\\" && quote !== "'" && i + 1 < source.length) {
            const next = source[++i];
            if (next !== "\n") {
                word += next;
                started = true;
            }
        } else if (quote) {
            if (c === quote) quote = "";
            else word += c;
        } else if (c === "'" || c === '"') {
            quote = c;
            started = true;
        } else if (c === "#" && !started) {
            while (i < source.length && source[i] !== "\n") i++;
            flushCommand();
        } else if ("\n;|&".includes(c)) {
            flushCommand();
        } else if (/\s/.test(c)) {
            flushWord();
        } else {
            word += c;
            started = true;
        }
    }
    flushCommand();
    return result;
}

function inspect(root) {
    root = path.resolve(root);
    const relative = (file) =>
        path.relative(root, file).split(path.sep).join("/");
    const testFiles = [
        ...filesBelow(path.join(root, "tests")),
        ...filesBelow(path.join(root, ".github/release-tests")),
    ]
        .filter(
            (file) =>
                /(?:^test[-_].*\.(?:cjs|ts|py)$|\.spec\.(?:cjs|ts)$|^android_provider_policy\.cjs$)/.test(
                    path.basename(file)
                ) || file.endsWith("/tests/variant_str_iter.rs")
        )
        .map(relative);
    const known = new Set(testFiles);
    const packageJson = JSON.parse(
        fs.readFileSync(path.join(root, "package.json"), "utf8")
    );
    const policy = JSON.parse(
        fs.readFileSync(path.join(root, "tests/ci-inventory.json"), "utf8")
    );
    const reached = new Map();
    const npmSeen = new Set();
    const errors = [];
    function visit(file, args = []) {
        if (!known.has(file)) return;
        if (!reached.has(file)) reached.set(file, new Set());
        const variants = reached.get(file);
        const key = JSON.stringify(args);
        if (variants.has(key)) return;
        variants.add(key);
        if (!/\.(?:cjs|ts)$/.test(file)) return;
        const ast = ts.createSourceFile(
            file,
            fs.readFileSync(path.join(root, file), "utf8"),
            ts.ScriptTarget.Latest,
            true
        );
        function walk(node) {
            let specifier;
            if (
                ts.isCallExpression(node) &&
                node.arguments.length === 1 &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) &&
                        node.expression.text === "require"))
            ) {
                specifier = node.arguments[0];
            } else if (ts.isImportDeclaration(node)) {
                specifier = node.moduleSpecifier;
            }
            if (
                specifier &&
                ts.isStringLiteral(specifier) &&
                specifier.text.startsWith(".")
            ) {
                visit(
                    relative(
                        path.resolve(root, path.dirname(file), specifier.text)
                    )
                );
            }
            ts.forEachChild(node, walk);
        }
        walk(ast);
    }
    function readCommands(source, cwd = root) {
        for (let words of commands(source)) {
            while (
                words.length &&
                (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0]) ||
                    words[0] === "env")
            )
                words = words.slice(1);
            if (!words.length) continue;
            if (
                words[0] === "npm" &&
                (words[1] === "run" || words[1] === "test")
            ) {
                const name = words[1] === "test" ? "test" : words[2];
                if (npmSeen.has(name)) continue;
                npmSeen.add(name);
                if (!packageJson.scripts[name])
                    errors.push(`Missing npm script: ${name}`);
                else readCommands(packageJson.scripts[name], cwd);
            } else if (
                (words[0] === "playwright" && words[1] === "test") ||
                (words[0] === "npx" &&
                    words[1] === "playwright" &&
                    words[2] === "test")
            ) {
                // Require explicit spec paths so an unused npm script, install
                // command or unrelated Playwright invocation cannot count as CI.
                if (
                    words.some((word) =>
                        ["--list", "--help", "-h", "--version", "-V"].includes(
                            word
                        )
                    )
                )
                    continue;
                for (const file of words.slice(words[0] === "npx" ? 3 : 2)) {
                    if (/\.spec\.(?:cjs|ts)$/.test(file))
                        visit(relative(path.resolve(cwd, file)));
                }
            } else if (["node", "python3", "python"].includes(words[0])) {
                if (
                    words[1] === "scripts/test-python.py" &&
                    !words.some((word) => ["--help", "-h"].includes(word))
                ) {
                    const profile = words.includes("--profile")
                        ? words[words.indexOf("--profile") + 1]
                        : "portable";
                    const suites = JSON.parse(
                        fs.readFileSync(
                            path.join(root, "tests/python-suites.json"),
                            "utf8"
                        )
                    );
                    if (!suites[profile])
                        errors.push(`Unknown Python suite profile: ${profile}`);
                    else
                        for (const [file, ...args] of suites[profile])
                            visit(file, args);
                } else if (
                    words.includes("unittest") &&
                    words.includes("discover")
                ) {
                    const directory = words[words.indexOf("-s") + 1];
                    const pattern = words.includes("-p")
                        ? words[words.indexOf("-p") + 1]
                        : "test*.py";
                    const glob = new RegExp(
                        "^" +
                            pattern
                                .split("*")
                                .map((s) =>
                                    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                                )
                                .join(".*") +
                            "$"
                    );
                    for (const file of filesBelow(
                        path.resolve(cwd, directory)
                    )) {
                        if (glob.test(path.basename(file)))
                            visit(relative(file));
                    }
                } else {
                    const index = words.findIndex(
                        (word, i) =>
                            i > 0 &&
                            !word.startsWith("-") &&
                            /\.(?:cjs|ts|py)$/.test(word)
                    );
                    if (index >= 0)
                        visit(
                            relative(path.resolve(cwd, words[index])),
                            words.slice(index + 1)
                        );
                }
            } else if (
                words[0] === "cargo" &&
                words[1] === "test" &&
                words.includes("--manifest-path")
            ) {
                const manifest = words[words.indexOf("--manifest-path") + 1];
                for (const file of filesBelow(
                    path.resolve(cwd, path.dirname(manifest), "tests")
                ))
                    visit(relative(file));
            }
        }
    }
    const workflows = new Map();
    for (const file of filesBelow(path.join(root, ".github/workflows")).filter(
        (file) => /\.ya?ml$/.test(file)
    )) {
        workflows.set(
            relative(file),
            YAML.parse(fs.readFileSync(file, "utf8"))
        );
    }
    const workflowSeen = new Set();
    const disabled = (condition) =>
        condition === false ||
        ["false", "${{ false }}"].includes(String(condition).trim());
    function visitWorkflow(file) {
        if (workflowSeen.has(file)) return;
        workflowSeen.add(file);
        const workflow = workflows.get(file);
        if (!workflow) {
            errors.push(`Missing reusable workflow: ${file}`);
            return;
        }
        for (const job of Object.values(workflow.jobs || {})) {
            if (disabled(job.if)) continue;
            if (job.uses?.startsWith("./.github/workflows/"))
                visitWorkflow(job.uses.slice(2));
            for (const step of job.steps || []) {
                if (typeof step.run === "string" && !disabled(step.if)) {
                    const directory =
                        step["working-directory"] ||
                        job.defaults?.run?.["working-directory"] ||
                        workflow.defaults?.run?.["working-directory"] ||
                        ".";
                    readCommands(step.run, path.resolve(root, directory));
                }
            }
        }
    }
    for (const [file, workflow] of workflows) {
        const triggers =
            typeof workflow.on === "string"
                ? [workflow.on]
                : Array.isArray(workflow.on)
                  ? workflow.on
                  : Object.keys(workflow.on || {});
        if (
            triggers.some((trigger) =>
                [
                    "push",
                    "pull_request",
                    "pull_request_target",
                    "merge_group",
                    "schedule",
                ].includes(trigger)
            )
        )
            visitWorkflow(file);
    }
    const excluded = policy.excluded || {};
    for (const [file, reason] of Object.entries(excluded)) {
        if (typeof reason !== "string" || reason.trim().length < 12)
            errors.push(`Exclusion needs a concrete reason: ${file}`);
        if (!known.has(file)) errors.push(`Stale exclusion: ${file}`);
        if (reached.has(file))
            errors.push(`Remove exclusion for covered test: ${file}`);
    }
    for (const file of testFiles) {
        if (!reached.has(file) && !Object.hasOwn(excluded, file))
            errors.push(`Test unreachable from CI: ${file}`);
    }
    for (const [file, variants] of Object.entries(
        policy.requiredVariants || {}
    )) {
        if (!known.has(file)) errors.push(`Missing required test: ${file}`);
        for (const args of variants) {
            if (!reached.get(file)?.has(JSON.stringify(args)))
                errors.push(`Missing CI variant: ${file} ${args.join(" ")}`);
        }
    }
    return {
        discovered: testFiles.length,
        errors,
        excluded: Object.keys(excluded).length,
        reached: reached.size,
    };
}

if (require.main === module) {
    const result = inspect(path.resolve(__dirname, ".."));
    if (result.errors.length) {
        console.error(result.errors.join("\n"));
        process.exitCode = 1;
    } else {
        console.log(
            `PASS CI inventory: ${result.reached}/${result.discovered} tests reachable, ${result.excluded} justified exclusions`
        );
    }
}
module.exports = { commands, inspect };
