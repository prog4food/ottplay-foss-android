"use strict";
const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm"),
    ts = require("typescript");
const root = path.resolve(__dirname, "../..");
function ast(file) {
    return ts.createSourceFile(
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
}
function declarations(file) {
    const source = ast(file);
    return source.statements.filter(ts.isFunctionDeclaration).map((node) => ({
        name: node.name.text,
        node,
        source,
        text: node.getText(source),
    }));
}
const encoding = ast("src/utils/encoding.ts");
const encodingCode = ts.transpileModule(
    encoding.statements
        .map((node) => node.getText(encoding).replace(/^export\s+/, ""))
        .join("\n"),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
function context() {
    const ctx = vm.createContext({
        _: (value) => value,
        alert: (value) => {
            throw new Error(value);
        },
        callbacks: 0,
        cats: {},
        catsArray: [],
        chanels: {},
        cList: [],
        console: { error() {}, log() {} },
        errors: [],
    });
    ctx.window = ctx;
    vm.runInContext(
        fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"),
        ctx
    );
    vm.runInContext(encodingCode, ctx);
    ctx.StripHttp = ctx.stripHttpScheme;
    return ctx;
}
function snapshot(ctx) {
    return JSON.parse(
        JSON.stringify({
            callbacks: ctx.callbacks,
            channels: ctx.chanels,
            groupOrder: ctx.catsArray,
            groups: ctx.cats,
            ids: ctx.cList,
        })
    );
}
function parsers(directory = "providers") {
    return fs
        .readdirSync(path.join(root, directory), { withFileTypes: true })
        .flatMap((entry) => {
            const file = directory + "/" + entry.name;
            if (entry.isDirectory()) return parsers(file);
            if (entry.name !== "provider.js") return [];
            return declarations(file)
                .filter((row) => /_parseM3U$/.test(row.name))
                .map((row) => ({ file, name: row.name }));
        });
}
function generic(parser, input) {
    const ctx = context(),
        code = declarations(parser.file)
            .filter((row) => [parser.name, "addChan2cat"].includes(row.name))
            .map((row) => row.text)
            .join("\n");
    require("./operator-fixture-host.cjs")(ctx);
    vm.runInContext(code, ctx);
    ctx[parser.name](input, () => ctx.callbacks++);
    return snapshot(ctx);
}
function main(input, fallback = "48") {
    const ctx = context(),
        top = declarations("providers/m3u/provider.js"),
        get = top.find((row) => row.name === "getChanelsArray");
    const local = get.node.body.statements
        .filter(ts.isFunctionDeclaration)
        .filter((node) => ["O", "I", "r"].includes(node.name.text))
        .map((node) => node.getText(get.source))
        .join("\n");
    Object.assign(ctx, {
        a: () => ctx.callbacks++,
        getLogoList: (config, body) => {
            ctx.logoBody = body;
        },
        m3uArr: { active: 0, M3Us: [{ rechours: fallback }] },
        provEpgLoader: (config, body) => {
            ctx.epgConfig = config;
            ctx.epgBody = body;
        },
    });
    vm.runInContext(
        top.find((row) => row.name === "addChan2cat").text + "\n" + local,
        ctx
    );
    ctx.r(input);
    return {
        ...snapshot(ctx),
        epgBody: ctx.epgBody,
        epgConfig: JSON.parse(JSON.stringify(ctx.epgConfig)),
        logoBody: ctx.logoBody || "",
    };
}
module.exports = { declarations, generic, main, parsers };
function operator(profile, input) {
    const ctx = context(),
        file = "providers/" + profile + "/provider.js",
        top = declarations(file);
    const get = top.find((row) => row.name === "getChanelsArray");
    const success = get.node.body.statements.find(
        (node) =>
            ts.isFunctionDeclaration(node) && node.name.text === "aSuccess"
    );
    ctx.alert = (message) => ctx.errors.push(message);
    Object.assign(ctx, {
        __id: "fixture",
        __pin: "fixture",
        callback: () => ctx.callbacks++,
        getEpgList: (value) => {
            ctx.epgBody = value;
        },
        getLogoList: (value) => {
            ctx.logoBody = value;
        },
        key: "12345678",
        login: "12345678",
        pass: "12345678",
        shkey: "12345678",
        token: "1234567890",
        tvteamwww: "https://fixture.test/",
    });
    if (profile === "shura") {
        ctx.cList = ["one", "two"];
        ctx.chanels = {
            one: { channel_name: "One" },
            two: { channel_name: "Two" },
        };
    }
    vm.runInContext(
        top
            .filter((row) =>
                ["getAttribute", "getAint", "addChan2cat"].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n") +
            "\n" +
            success.getText(get.source),
        ctx
    );
    ctx.aSuccess(input);
    return JSON.parse(
        JSON.stringify({
            ...snapshot(ctx),
            epgBody: ctx.epgBody,
            errors: ctx.errors,
            logoBody: ctx.logoBody,
        })
    );
}
function media(profile, input) {
    const ctx = context(),
        top = declarations("providers/" + profile + "/provider.js");
    require("./operator-fixture-host.cjs")(ctx);
    ctx.mediaName = "";
    ctx.alert = (message) => ctx.errors.push(message);
    vm.runInContext(
        top
            .filter((row) =>
                ["getMediaArrayEXTM3U", "getAttribute"].includes(row.name)
            )
            .map((row) => row.text)
            .join("\n"),
        ctx
    );
    ctx.getMediaArrayEXTM3U(input);
    return JSON.parse(
        JSON.stringify({
            errors: ctx.errors,
            name: ctx.mediaName,
            records: ctx.mediaRecords,
        })
    );
}
module.exports.operator = operator;
module.exports.media = media;
module.exports.context = context;
