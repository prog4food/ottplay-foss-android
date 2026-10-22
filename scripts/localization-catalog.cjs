/**
 * Source-derived localization inventory for the shipped classic player.
 * Only translation entry points and explicit UI schemas are inspected: logging,
 * protocol tokens, provider metadata and arbitrary source literals are not keys.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
// Read the same exported contract used by both player entry points. Keeping the
// stored identifiers here would let packaged filenames and runtime loading drift.
const languageAssetModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(
        fs.readFileSync(path.join(root, "src/localization/assets.ts"), "utf8"),
        {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText,
    languageAssetModule,
    { timeout: 1000 }
);
const { languageNames, languageAssetPath } = languageAssetModule.exports;
const languageAssets = Object.fromEntries(
    Object.keys(languageNames).map((code) => [code, languageAssetPath(code)])
);
const metadataKeys = new Set(["alhabet", "lang"]);
const expressionPrinter = ts.createPrinter({ removeComments: true });

function filesIn(directory, suffix) {
    return fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const file = path.join(directory, entry.name);
            return entry.isDirectory()
                ? filesIn(file, suffix)
                : suffix.test(entry.name)
                  ? [file]
                  : [];
        })
        .sort();
}
function parse(file) {
    return ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
}
function visit(node, callback) {
    callback(node);
    ts.forEachChild(node, (child) => visit(child, callback));
}
function name(node) {
    return ts.isIdentifier(node) || ts.isStringLiteral(node)
        ? node.text
        : ts.isPropertyAccessExpression(node)
          ? node.name.text
          : "";
}
function unwrap(node) {
    while (
        node &&
        (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    )
        node = node.expression;
    return node;
}
function readDictionary(file) {
    const ast = parse(file);
    const seen = new Set();
    const definitions = [];
    visit(ast, (node) => {
        if (ts.isVariableDeclaration(node) && name(node.name) === "keyStrings")
            definitions.push(node.initializer);
    });
    if (
        definitions.length !== 1 ||
        !ts.isObjectLiteralExpression(definitions[0])
    )
        throw new Error(`${file}: expected one literal keyStrings dictionary`);
    for (const property of definitions[0].properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isStringLiteral(property.initializer)
        )
            throw new Error(
                `${file}: dictionary entries must be literal strings`
            );
        const key = name(property.name);
        if (seen.has(key))
            throw new Error(`${file}: duplicate key ${JSON.stringify(key)}`);
        seen.add(key);
    }
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { timeout: 1000 });
    return { ...context.keyStrings };
}

function collectSourceKeys(repository = root) {
    const keys = new Set(metadataKeys);
    const locations = new Map();
    const dynamic = [];
    function add(value, file, node) {
        if (typeof value !== "string" || !value) return;
        keys.add(value);
        if (!locations.has(value)) locations.set(value, []);
        const line =
            node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
                .line + 1;
        locations.get(value).push(`${file}:${line}`);
    }
    for (const file of ["src", "devices", "providers"].flatMap((directory) =>
        filesIn(path.join(repository, directory), /\.(?:ts|js)$/)
    )) {
        const relative = path.relative(repository, file).replace(/\\/g, "/");
        const ast = parse(file);
        const declarations = [];
        visit(ast, (node) => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
                declarations.push(node);
        });
        function binding(identifier) {
            let scope = identifier.parent;
            while (scope) {
                if (
                    ts.isFunctionLike(scope) &&
                    scope.parameters.some(
                        (parameter) => name(parameter.name) === identifier.text
                    )
                )
                    return null;
                const candidates = declarations.filter((declaration) => {
                    if (declaration.name.text !== identifier.text) return false;
                    let parent = declaration.parent;
                    while (
                        parent &&
                        parent !== scope &&
                        !ts.isFunctionLike(parent) &&
                        !ts.isSourceFile(parent) &&
                        !ts.isBlock(parent)
                    )
                        parent = parent.parent;
                    return parent === scope;
                });
                if (candidates.length === 1) return candidates[0].initializer;
                scope = scope.parent;
            }
            return null;
        }
        function values(expression, trail = new Set()) {
            const node = unwrap(expression);
            if (!node || trail.has(node)) return null;
            const next = new Set(trail).add(node);
            if (ts.isStringLiteralLike(node)) return [node.text];
            if (ts.isConditionalExpression(node)) {
                const yes = values(node.whenTrue, next),
                    no = values(node.whenFalse, next);
                return yes && no ? [...yes, ...no] : null;
            }
            if (ts.isIdentifier(node)) return values(binding(node), next);
            if (ts.isArrayLiteralExpression(node)) {
                const entries = node.elements.map((entry) =>
                    values(entry, next)
                );
                return entries.every(Boolean) ? entries.flat() : null;
            }
            if (ts.isObjectLiteralExpression(node)) {
                const entries = node.properties.map((property) =>
                    ts.isPropertyAssignment(property)
                        ? values(property.initializer, next)
                        : null
                );
                return entries.every(Boolean) ? entries.flat() : null;
            }
            if (ts.isElementAccessExpression(node))
                return values(node.expression, next);
            if (ts.isBinaryExpression(node)) {
                const left = values(node.left, next),
                    right = values(node.right, next);
                if (
                    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                    left &&
                    right
                )
                    return left.flatMap((a) => right.map((b) => a + b));
                if (
                    node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
                    left &&
                    right
                )
                    return [...left, ...right];
            }
            return null;
        }
        function collect(expression, reportDynamic = false) {
            if (!expression) return;
            const resolved = values(expression);
            if (resolved)
                for (const value of resolved) add(value, relative, expression);
            else {
                const node = unwrap(expression);
                if (
                    ts.isCallExpression(node) &&
                    ["_", "translate"].includes(name(node.expression))
                ) {
                    collect(node.arguments[0]);
                    return;
                }
                // A conditional can combine a static label with runtime metadata.
                if (ts.isConditionalExpression(node)) {
                    collect(node.whenTrue);
                    collect(node.whenFalse);
                }
                if (reportDynamic)
                    dynamic.push({
                        expression: expressionPrinter
                            .printNode(ts.EmitHint.Expression, node, ast)
                            .replace(/\s+/g, " "),
                        file: relative,
                    });
            }
        }
        visit(ast, (node) => {
            if (
                relative === "src/plugins/diagnostics-controller.ts" &&
                ts.isPropertyAssignment(node) &&
                name(node.name) === "message"
            )
                collect(node.initializer);
            if (ts.isCallExpression(node)) {
                const method = name(node.expression);
                const argument = {
                    _: 0,
                    confirmBox: 0,
                    createSettingsPage: 2,
                    label: 0,
                    renderButtonHint: 2,
                    translate: 0,
                }[method];
                if (
                    argument !== undefined &&
                    relative !== "src/swop/herenow-phone.ts"
                )
                    collect(node.arguments[argument], true);
                // Wrappers with a documented translation boundary.
                if (relative === "src/settings/cloud.ts" && method === "fail")
                    collect(node.arguments[0], true);
                if (
                    (relative === "src/ui/index.ts" ||
                        relative === "src/channels/classic-search.ts") &&
                    method === "hint"
                )
                    collect(node.arguments[2], true);
                if (
                    relative === "src/settings/transfer-ui.ts" &&
                    method === "notice"
                )
                    collect(node.arguments[0], true);
                if (
                    relative === "src/channels/classic-search.ts" &&
                    method === "hint"
                )
                    collect(node.arguments[2]);
                if (
                    (relative === "src/index.ts" ||
                        relative === "providers/edem/provider.js") &&
                    method === "it"
                )
                    collect(node.arguments[1]);
                if (
                    relative === "src/provider/edem-driver.ts" &&
                    method === "field"
                )
                    collect(node.arguments[1]);
                if (
                    relative === "src/provider/m3u-settings.ts" &&
                    method === "openList"
                )
                    collect(node.arguments[0]);
                if (
                    relative === "src/plugins/command-server.ts" &&
                    method === "update"
                )
                    collect(node.arguments[1]);
                if (
                    relative === "src/plugins/control-discovery.ts" &&
                    ["notify", "finish"].includes(method)
                )
                    collect(node.arguments[1]);
                if (
                    relative === "src/plugins/remote-screenshot.ts" &&
                    method === "failSelection"
                )
                    collect(node.arguments[0], true);
                if (
                    relative.startsWith("src/provider/") &&
                    method === "progress" &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    name(node.expression.expression) === "ports"
                )
                    collect(node.arguments[0]);
                // These arrays are rendered by optionsList/infoList through _().
                if (
                    ["src/index.ts", "src/provider/index.ts"].includes(
                        relative
                    ) &&
                    method === "push" &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    ["optionsArr", "infoArr"].includes(
                        name(node.expression.expression)
                    )
                ) {
                    for (const argument of node.arguments)
                        if (ts.isObjectLiteralExpression(argument))
                            for (const property of argument.properties)
                                if (
                                    ts.isPropertyAssignment(property) &&
                                    ["name", "desc"].includes(
                                        name(property.name)
                                    )
                                )
                                    collect(property.initializer);
                }
            }
            if (ts.isVariableDeclaration(node)) {
                const id = name(node.name);
                if (
                    relative === "src/ui/menu-registry.ts" &&
                    id === "screenMenuDefinitions" &&
                    ts.isArrayLiteralExpression(node.initializer)
                ) {
                    for (const row of node.initializer.elements)
                        if (ts.isArrayLiteralExpression(row)) {
                            collect(row.elements[2]);
                            collect(row.elements[3]);
                            if (
                                row.elements[0] &&
                                [
                                    "pip.toggle",
                                    "playback.live",
                                    "playback.toggle",
                                ].includes(row.elements[0].text)
                            )
                                for (const label of row.elements[2].text.split(
                                    "/"
                                ))
                                    add(label.trim(), relative, row);
                        }
                }
                if (
                    relative === "src/index.ts" &&
                    id === "infoArr" &&
                    ts.isArrayLiteralExpression(node.initializer)
                ) {
                    for (const row of node.initializer.elements)
                        if (ts.isObjectLiteralExpression(row))
                            for (const property of row.properties)
                                if (
                                    ts.isPropertyAssignment(property) &&
                                    ["name", "desc"].includes(
                                        name(property.name)
                                    )
                                )
                                    collect(property.initializer);
                }
                if (
                    [
                        "src/plugins/command-server.ts",
                        "src/plugins/control-discovery.ts",
                        "src/plugins/remote-screenshot.ts",
                    ].includes(relative) &&
                    (id === "message" ||
                        (relative === "src/plugins/remote-screenshot.ts" &&
                            id === "text"))
                )
                    collect(node.initializer);
            }
            if (
                ["src/index.ts", "src/plugins/remote-screenshot.ts"].includes(
                    relative
                ) &&
                ts.isBinaryExpression(node) &&
                (name(node.left) === "message" ||
                    (relative === "src/plugins/remote-screenshot.ts" &&
                        name(node.left) === "text")) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            )
                collect(node.right);
            if (
                relative === "src/provider/driver-profiles.ts" &&
                ts.isObjectLiteralExpression(node)
            ) {
                const properties = Object.fromEntries(
                    node.properties
                        .filter(ts.isPropertyAssignment)
                        .map((property) => [
                            name(property.name),
                            property.initializer,
                        ])
                );
                if (
                    properties.kind &&
                    ["operator", "xtream-fallback"].includes(
                        properties.kind.text
                    ) &&
                    properties.title &&
                    ts.isStringLiteral(properties.title)
                ) {
                    const title = properties.title.text;
                    for (const key of [
                        title,
                        title + " settings",
                        "Configure " +
                            title +
                            " in Settings -> Provider Settings",
                    ])
                        add(key, relative, node);
                }
            }
            // Command validation errors are displayed as status.message by settingsCommands.
            if (
                relative === "src/plugins/command-server.ts" &&
                ts.isNewExpression(node) &&
                name(node.expression) === "Error"
            )
                collect(node.arguments && node.arguments[0]);
            if (
                relative === "src/plugins/command-server.ts" &&
                ts.isBinaryExpression(node) &&
                name(node.left) === "lastCommandMessage" &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            )
                collect(node.right);
        });
    }
    // The phone page ships a finite subset of these same dictionaries. Reuse
    // the build extractor so its HTML and wrapper calls cannot drift from CI.
    const phoneFile = path.join(repository, "src/swop/herenow-phone.ts");
    if (fs.existsSync(phoneFile)) {
        const { phoneKeys, PHONE_HTML } = require("./hosted-swop.cjs");
        const ast = parse(phoneFile);
        for (const key of phoneKeys(
            PHONE_HTML,
            fs.readFileSync(phoneFile, "utf8")
        ))
            add(key, "src/swop/herenow-phone.ts", ast);
    }
    // Boot runs before the player translator exists, but uses the same catalog.
    const bootFile = path.join(repository, "index.html");
    if (fs.existsSync(bootFile)) {
        const html = fs.readFileSync(bootFile, "utf8");
        let offset = 0;
        for (const script of require("./html-scripts.cjs").inlineScripts(
            html
        )) {
            if (!script) continue;
            const start = html.indexOf(script, offset);
            offset = start + script.length;
            const ast = ts.createSourceFile(
                "index.html",
                html.slice(0, start).replace(/[^\n]/g, " ") + script,
                ts.ScriptTarget.Latest,
                true
            );
            visit(ast, (node) => {
                if (
                    ts.isCallExpression(node) &&
                    ["bootStatus", "bootText"].includes(
                        name(node.expression)
                    ) &&
                    node.arguments[0] &&
                    ts.isStringLiteral(node.arguments[0])
                )
                    add(
                        node.arguments[0].text,
                        "index.html",
                        node.arguments[0]
                    );
            });
        }
    }
    return { dynamic, keys, locations };
}
function placeholders(text) {
    return (text.match(/%\d+/g) || []).sort();
}
function htmlTags(text) {
    return (text.match(/<\/?[a-z][^>]*>/gi) || []).map((tag) =>
        tag.toLowerCase().replace(/\s*\/?\s*>$/, ">")
    );
}
function validateDictionary(reference, translated, file) {
    const errors = [];
    for (const key of Object.keys(reference)) {
        if (!Object.hasOwn(translated, key)) {
            errors.push(`${file}: missing ${JSON.stringify(key)}`);
            continue;
        }
        if (typeof translated[key] !== "string" || !translated[key].trim()) {
            errors.push(`${file}: empty ${JSON.stringify(key)}`);
            if (typeof translated[key] !== "string") continue;
        }
        if (
            JSON.stringify(placeholders(reference[key])) !==
            JSON.stringify(placeholders(translated[key]))
        )
            errors.push(
                `${file}: placeholders differ for ${JSON.stringify(key)}`
            );
        if (
            JSON.stringify(htmlTags(reference[key])) !==
            JSON.stringify(htmlTags(translated[key]))
        )
            errors.push(`${file}: HTML tags differ for ${JSON.stringify(key)}`);
        for (const marker of translated[key].match(
            /\b0\d{3}\b|ZXQ\s*\d+\s*QXZ|ЗКСК\s*\d+\s*ККСЗ/g
        ) || [])
            if (!reference[key].includes(marker))
                errors.push(
                    `${file}: translation batch marker ${JSON.stringify(marker)} in ${JSON.stringify(key)}`
                );
        // These literals are copied or entered by users. Translating one makes
        // otherwise fluent connection/setup instructions unusable.
        for (const literal of reference[key].match(
            /https?:\/\/[^\s)<>]+|ott approve NAME CODE|Authorization: Bearer|\/playlist\.m3u8|host_ott|OTT-play/g
        ) || [])
            if (!translated[key].includes(literal))
                errors.push(
                    `${file}: technical literal ${JSON.stringify(literal)} differs for ${JSON.stringify(key)}`
                );
        if (
            /^\s/.test(reference[key]) !== /^\s/.test(translated[key]) ||
            /\s$/.test(reference[key]) !== /\s$/.test(translated[key])
        )
            errors.push(
                `${file}: boundary whitespace differs for ${JSON.stringify(key)}`
            );
    }
    for (const key of Object.keys(translated))
        if (!Object.hasOwn(reference, key))
            errors.push(`${file}: noncanonical ${JSON.stringify(key)}`);
    return errors;
}
function sameEnglishText(left, right) {
    function normalized(value) {
        return value
            .replace(/<\/?[a-z][^>]*>/gi, (tag) =>
                tag.toLowerCase().replace(/\s*\/?\s*>$/, ">")
            )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    }
    return (
        typeof left === "string" &&
        typeof right === "string" &&
        normalized(left) === normalized(right)
    );
}
/** Identical prose is a missing translation even when structural parity passes. */
function validateEnglishFallbacks(reference, translated, file, allowed) {
    const locale = path.basename(file, ".js");
    if (locale === "english") return [];
    const errors = [];
    for (const [key, value] of Object.entries(reference)) {
        if (metadataKeys.has(key) || !sameEnglishText(value, translated[key]))
            continue;
        const reviewed = allowed.some(
            (entry) =>
                entry &&
                entry.key === key &&
                entry.value === value &&
                Array.isArray(entry.locales) &&
                (entry.locales.includes("*") || entry.locales.includes(locale))
        );
        if (!reviewed)
            errors.push(
                `${file}: untranslated English ${JSON.stringify(key)}; translate it or review a genuine identical term in localization-identical.json`
            );
    }
    return errors;
}
/** Exceptions pin the English value and exact locales; stale entries fail CI. */
function validateIdenticalAllowlist(reference, dictionaries, entries) {
    const errors = [],
        seen = new Set();
    for (const entry of entries) {
        if (
            !entry ||
            typeof entry.key !== "string" ||
            !Object.hasOwn(reference, entry.key) ||
            metadataKeys.has(entry.key) ||
            entry.value !== reference[entry.key] ||
            typeof entry.reason !== "string" ||
            entry.reason.trim().length < 10 ||
            !Array.isArray(entry.locales) ||
            !entry.locales.length ||
            (entry.locales.includes("*") && entry.locales.length !== 1)
        ) {
            errors.push(
                "Invalid reviewed identical-text exception: " +
                    JSON.stringify(entry)
            );
            continue;
        }
        for (const locale of entry.locales) {
            const id = entry.key + ":" + locale;
            if (
                seen.has(id) ||
                locale === "english" ||
                (locale !== "*" && !Object.hasOwn(dictionaries, locale))
            )
                errors.push(
                    "Duplicate or unknown identical-text exception: " + id
                );
            seen.add(id);
            const applicable =
                locale === "*"
                    ? Object.values(dictionaries)
                    : [dictionaries[locale]];
            if (
                !applicable.some(
                    (dictionary) =>
                        dictionary &&
                        sameEnglishText(entry.value, dictionary[entry.key])
                )
            )
                errors.push("Unused identical-text exception: " + id);
        }
    }
    return errors;
}
function audit({ englishOnly = false } = {}) {
    const reference = readDictionary(
        path.join(root, languageAssetPath("_eng"))
    );
    const inventory = collectSourceKeys();
    const errors = [];
    const boundaries = JSON.parse(
        fs.readFileSync(
            path.join(root, "scripts/localization-dynamic.json"),
            "utf8"
        )
    );
    const known = new Set(
        boundaries.entries.map((entry) => entry.file + ":" + entry.expression)
    );
    for (const entry of inventory.dynamic)
        if (!known.has(entry.file + ":" + entry.expression))
            errors.push(
                `Unaudited dynamic translation boundary: ${entry.file}: ${entry.expression}`
            );
    for (const key of inventory.keys)
        if (!Object.hasOwn(reference, key))
            errors.push(
                `English catalog lacks source key ${JSON.stringify(key)} (${inventory.locations.get(key)?.[0] || "metadata"})`
            );
    const locales = filesIn(path.join(root, "locales"), /\.js$/);
    const identical = JSON.parse(
        fs.readFileSync(
            path.join(root, "scripts/localization-identical.json"),
            "utf8"
        )
    ).entries;
    const dictionaries = {};
    for (const file of locales) {
        const dictionary = readDictionary(file);
        const locale = path.basename(file, ".js");
        if (locale !== "english") dictionaries[locale] = dictionary;
        // English is the union contract: legacy keys may not silently disappear.
        for (const key of Object.keys(dictionary))
            if (!Object.hasOwn(reference, key))
                errors.push(
                    `English catalog lacks existing locale key ${JSON.stringify(key)} (${path.basename(file)})`
                );
        if (!englishOnly)
            errors.push(
                ...validateDictionary(
                    reference,
                    dictionary,
                    path.basename(file)
                ),
                ...validateEnglishFallbacks(
                    reference,
                    dictionary,
                    file,
                    identical
                )
            );
    }
    if (!englishOnly) {
        errors.push(
            ...validateIdenticalAllowlist(reference, dictionaries, identical)
        );
        let codes;
        visit(parse(path.join(root, "src/index.ts")), (node) => {
            if (
                !ts.isVariableDeclaration(node) ||
                !node.initializer ||
                !ts.isArrayLiteralExpression(node.initializer)
            )
                return;
            if (name(node.name) === "langCodes")
                codes = node.initializer.elements.map((entry) => entry.text);
        });
        if (
            !codes ||
            codes.length !== Object.keys(languageNames).length ||
            codes.some((code) => !Object.hasOwn(languageNames, code)) ||
            new Set(codes).size !== codes.length
        )
            errors.push(
                "Language selector must have unique codes and one display name for every code"
            );
        else {
            const files = new Set(
                locales.map((file) => "/locales/" + path.basename(file))
            );
            const paths = Object.values(languageAssets);
            if (new Set(paths).size !== paths.length)
                errors.push(
                    "Language identifiers must resolve to distinct assets"
                );
            for (const code of codes)
                if (
                    !Object.hasOwn(languageAssets, code) ||
                    !files.has(languageAssets[code])
                )
                    errors.push(`Language selector asset missing: ${code}`);
            for (const [code, file] of Object.entries(languageAssets)) {
                if (!/^[A-Z][a-z]+(?: - .+)?$/.test(languageNames[code]))
                    errors.push(
                        `Language label needs an English asset name: ${code}`
                    );
                if (!codes.includes(code))
                    errors.push(`Locale asset absent from selector: ${code}`);
                if (!/^\/locales\/[a-z]+(?:-[a-z]+)*\.js$/.test(file))
                    errors.push(
                        `Locale asset must use an English filename: ${file}`
                    );
            }
            for (const file of files)
                if (!paths.includes(file))
                    errors.push(
                        `Locale asset absent from language map: ${file}`
                    );
        }
    }
    return {
        errors,
        keyCount: Object.keys(reference).length,
        localeCount: locales.length,
        sourceKeyCount: inventory.keys.size,
    };
}
if (require.main === module) {
    if (process.argv.includes("--inventory")) {
        const inventory = collectSourceKeys();
        console.log(
            JSON.stringify(
                {
                    dynamic: inventory.dynamic,
                    keys: [...inventory.keys].sort(),
                },
                null,
                2
            )
        );
    } else {
        const result = audit({
            englishOnly: process.argv.includes("--english-only"),
        });
        if (result.errors.length) {
            console.error(result.errors.join("\n"));
            process.exitCode = 1;
        } else
            console.log(
                `PASS localization catalog: ${result.keyCount} keys, ${result.sourceKeyCount} source keys, ${result.localeCount} locales${process.argv.includes("--english-only") ? " (English contract only)" : ""}`
            );
    }
}
module.exports = {
    audit,
    collectSourceKeys,
    htmlTags,
    languageAssetPath,
    languageAssets,
    metadataKeys,
    placeholders,
    readDictionary,
    validateDictionary,
    validateEnglishFallbacks,
    validateIdenticalAllowlist,
};
