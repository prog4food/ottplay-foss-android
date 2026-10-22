// Real npm runtime + source-asset staging, without a frontend/native build.
// JSDOM verifies script/DOM/AJAX contracts, not codecs, OS fonts or device rendering.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const {
    auditNativeRuntime,
    stageNativeRuntime,
} = require("../scripts/native-runtime.cjs");
const { containsPrivateUse } = require("../scripts/play-system-icons.cjs");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-native-runtime-"));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const compile = (code) =>
    ts
        .transpileModule(code, {
            compilerOptions: {
                module: ts.ModuleKind.ES2015,
                target: ts.ScriptTarget.ES2022,
            },
        })
        .outputText.replace(/^export /gm, "");
let cases = 0;
function pass(name) {
    cases++;
    console.log("PASS native runtime: " + name);
}
function walk(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(folder, entry.name);
        assert(!entry.isSymbolicLink(), "Unexpected fixture source symlink");
        return entry.isDirectory() ? walk(file) : [file];
    });
}
function snapshot() {
    return Object.fromEntries(
        ["js", "fonts"].flatMap((folder) =>
            walk(path.join(root, folder)).map((file) => [
                path.relative(root, file),
                hash(fs.readFileSync(file)),
            ])
        )
    );
}
function write(folder, file, bytes) {
    const target = path.join(folder, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
}
function inlineScriptSource(html) {
    const parsed = new JSDOM(html);
    try {
        return Array.from(
            parsed.window.document.querySelectorAll("script:not([src])"),
            (script) => script.textContent
        ).join("\n");
    } finally {
        parsed.window.close();
    }
}
assert.equal(
    inlineScriptSource(
        '<script data-label=">">window.first = 1;</script >' +
            '<script src="/external.js">window.external = 1;</script>' +
            "<!-- <script>window.comment = 1;</script> -->" +
            "<SCRIPT>window.second = 2;</SCRIPT\t>"
    ),
    "window.first = 1;\nwindow.second = 2;"
);
pass(
    "inline boot script extraction follows HTML parsing for attributes, comments and closing-tag whitespace"
);
function nodes(code, predicate) {
    const ast = ts.createSourceFile(
        "fixture.ts",
        code,
        ts.ScriptTarget.Latest,
        true
    );
    const found = [];
    function visit(node) {
        if (predicate(node)) found.push(node.getText(ast));
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return found;
}
function one(code, predicate) {
    const found = nodes(code, predicate);
    assert.equal(
        found.length,
        1,
        "Production declaration moved or became ambiguous"
    );
    return found[0];
}
const indexSource = read("src/index.ts");
const family = one(
    indexSource,
    (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "fontFamilyList"
);
const fontOptions = one(
    indexSource,
    (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        node.left.getText() === "w.__ottNativeFontOptions"
);
const applyFamily = one(
    indexSource,
    (node) =>
        ts.isExpressionStatement(node) &&
        node.getText().includes('$("body").css("font-family", fontFamilyList[')
);
const fallback = one(
    indexSource,
    (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText() === "s" &&
        node.initializer?.getText().includes("__ottNativeFontFamilies")
);
const coreIcons = nodes(
    read("src/core/index.ts"),
    (node) =>
        ts.isVariableDeclaration(node) &&
        /^str/.test(node.name.getText()) &&
        node.initializer?.getText().includes("fontello")
);
assert(coreIcons.length > 0, "No real core icon declarations in fixture");
const app = compile(
    [
        "var w = window;",
        "var " + family + ";",
        ...coreIcons.map((node) => "var " + node + ";"),
        "function fixtureFontOptions() { return " + fontOptions + "; }",
        "function fixtureApplyFont() { var " +
            fallback +
            "; " +
            applyFamily +
            " }",
        "window.fixturePlayerSawEnvironment = window.__ottNativeRuntime === true;",
    ].join("\n")
);
const original = snapshot();
const runtimeLibraries = [
    ["jquery", "dist/jquery.min.js", "js/jquery.min.js", "LICENSE.txt"],
    ["hls.js", "dist/hls.min.js", "js/hls.min.js", "LICENSE"],
    [
        "shaka-player",
        "dist/shaka-player.compiled.js",
        "js/shaka-player.compiled.js",
        "LICENSE",
    ],
];
function fixture(name, play) {
    const folder = path.join(temp, name);
    fs.mkdirSync(folder);
    write(folder, "index.html", read("index.html"));
    write(folder, "dist/player.js", app);
    for (const top of ["js", "fonts"]) {
        for (const file of walk(path.join(root, top)))
            write(folder, path.relative(root, file), fs.readFileSync(file));
    }
    write(folder, "styles/player.css", read("styles/player.css"));
    for (const lang of fs.readdirSync(path.join(root, "locales")))
        if (/\.js$/.test(lang))
            write(folder, "locales/" + lang, read("locales/" + lang));
    for (const device of ["android", "pc"])
        write(
            folder,
            "devices/" + device + "/device.js",
            read("devices/" + device + "/device.js")
        );
    const providers = play
        ? ["demo", "m3u", "plex", "stalker", "vportal", "xtream"]
        : fs
              .readdirSync(path.join(root, "providers"))
              .filter((id) =>
                  fs.existsSync(path.join(root, "providers", id, "provider.js"))
              );
    for (const id of providers) {
        // New managed families have no retained historical provider.js oracle.
        if (!fs.existsSync(path.join(root, "providers", id, "provider.js")))
            continue;
        write(
            folder,
            "providers/" + id + "/provider.js",
            read("providers/" + id + "/provider.js")
        );
    }
    return folder;
}
function verifyStage(folder, platform) {
    const manifest = auditNativeRuntime(folder);
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.fonts, "system");
    assert(!fs.existsSync(path.join(folder, "fonts")));
    assert(!fs.existsSync(path.join(folder, "js/jquery-1.11.1.min.js")));
    const lock = JSON.parse(read("package-lock.json"));
    for (const [name, source, file, license] of runtimeLibraries) {
        const upstream = path.join(root, "node_modules", name);
        const pkg = JSON.parse(
            fs.readFileSync(path.join(upstream, "package.json"))
        );
        const item = manifest.components.find((entry) => entry.name === name);
        assert.equal(item.version, pkg.version);
        assert.equal(
            item.version,
            lock.packages["node_modules/" + name].version
        );
        assert.equal(
            item.integrity,
            lock.packages["node_modules/" + name].integrity
        );
        assert.deepEqual(
            fs.readFileSync(path.join(folder, file)),
            fs.readFileSync(path.join(upstream, source))
        );
        assert.equal(
            item.sha256,
            hash(fs.readFileSync(path.join(upstream, source)))
        );
        assert.deepEqual(
            fs.readFileSync(
                path.join(folder, "licenses/native", name + "-LICENSE.txt")
            ),
            fs.readFileSync(path.join(upstream, license))
        );
    }
    for (const file of walk(folder)) {
        assert(!/\.(?:ttf|otf|eot|woff2?)$/i.test(file), file);
        if (
            !/\.(js|css|html)$/i.test(file) ||
            path.relative(folder, file).startsWith("js" + path.sep)
        )
            continue;
        const code = fs.readFileSync(file, "utf8");
        assert(!containsPrivateUse(code), "App PUA remains: " + file);
        assert(
            !/@font-face|fontello/i.test(code),
            "Webfont declaration remains: " + file
        );
    }
    const doc = new JSDOM(
        fs.readFileSync(path.join(folder, "index.html"), "utf8")
    );
    assert.equal(
        doc.window.document.querySelector("script").getAttribute("src"),
        "./js/runtime-polyfills.js?v=" +
            JSON.parse(read("js/media-runtime.json")).runtimeVersion
    );
    assert.equal(
        doc.window.document.querySelectorAll("script")[1].getAttribute("src"),
        "./js/native-environment.js"
    );
    doc.window.close();
    pass(
        platform +
            " stage: exact npm bytes/licenses, no custom fonts/PUA, polyfills before environment"
    );
}
function browser(folder, platform) {
    const dom = new JSDOM(
        "<!doctype html><html><head></head><body><div id='rows'></div></body></html>",
        {
            runScripts: "outside-only",
            url:
                platform === "tauri"
                    ? "http://tauri.localhost/"
                    : "https://localhost/",
        }
    );
    const w = dom.window;
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    // JSDOM has no MediaSource, codec pipeline or blob URL implementation.
    // The URL hooks allow library startup only; no decoding claim is made.
    w.URL.createObjectURL = () => "blob:fixture";
    w.URL.revokeObjectURL = () => {};
    w.XMLHttpRequest = function () {
        throw new Error("Unexpected real XHR");
    };
    w.fetch = () => {
        throw new Error("Unexpected real fetch");
    };
    w.WebSocket = function () {
        throw new Error("Unexpected WebSocket");
    };
    w.eval(
        fs.readFileSync(path.join(folder, "js/runtime-polyfills.js"), "utf8")
    );
    assert.equal(w.__ottRuntimePolyfillsReady, true);
    w.eval(
        fs.readFileSync(path.join(folder, "js/native-environment.js"), "utf8")
    );
    w.settings = { fontSize: 0 };
    w._ = (value) => value;
    w.host = "";
    w.__av = "fixture";
    w.ott_device = "pc"; // Must not select the PC CDN path in a native shell.
    w._head = w.document.head;
    w.bootStatus = () => {};
    w.bootLog = () => {};
    const loaded = [];
    w.loadCSS = () => {};
    w.loadSTB = () =>
        w.eval(fs.readFileSync(path.join(folder, "dist/player.js"), "utf8"));
    w.loadJS = (url, done) => {
        assert(
            url.startsWith("/js/"),
            "Native boot requested a non-local dependency: " + url
        );
        loaded.push(url);
        w.eval(
            fs.readFileSync(
                path.join(folder, url.slice(1).split("?")[0]),
                "utf8"
            )
        );
        done();
    };
    const inline = inlineScriptSource(read("index.html"));
    for (const name of ["loadJQ", "loadLibraries", "loadStandardLibraries"])
        w.eval(
            one(
                inline,
                (node) =>
                    ts.isFunctionDeclaration(node) && node.name?.text === name
            )
        );
    w.loadJS("/js/ottplay-core.js", () => {
        const guide = new w.OttPlayCore.NativeGuide(
            [
                ["news", "News"],
                ["film", "Films"],
            ],
            "web",
            (value) => value.length,
            (value) => value
        );
        assert.equal(guide.resolve("", ["News Extra", "Films"]), "film");
        w.loadJQ();
    });
    assert.deepEqual(loaded, [
        "/js/ottplay-core.js",
        "/js/jquery.min.js",
        "/js/hls.min.js?v=" + w.__ottMediaRuntimeVersion,
        "/js/shaka-player.compiled.js",
    ]);
    assert.equal(w.fixturePlayerSawEnvironment, true);
    return dom;
}
function jqResult(xhr) {
    return new Promise((resolve) => {
        xhr.done((data, status, request) =>
            resolve({ data, ok: true, request, status })
        );
        xhr.fail((request, status, error) =>
            resolve({ error, ok: false, request, status })
        );
    });
}
async function smoke(folder, platform) {
    const dom = browser(folder, platform);
    const w = dom.window;
    try {
        const $ = w.jQuery;
        assert.equal(
            $.fn.jquery,
            JSON.parse(read("node_modules/jquery/package.json")).version
        );
        assert.equal(
            w.Hls.version,
            JSON.parse(read("node_modules/hls.js/package.json")).version
        );
        assert.equal(
            w.shaka.Player.version.replace(/^v/, ""),
            JSON.parse(read("node_modules/shaka-player/package.json")).version
        );
        for (const method of [
            "loadSource",
            "attachMedia",
            "destroy",
            "recoverMediaError",
        ])
            assert.equal(typeof w.Hls.prototype[method], "function");
        for (const method of [
            "attach",
            "load",
            "destroy",
            "configure",
            "getVariantTracks",
            "selectVariantTrack",
        ])
            assert.equal(typeof w.shaka.Player.prototype[method], "function");
        assert.equal(
            w.Hls.isSupported(),
            false,
            "JSDOM must not claim MSE codec support"
        );
        pass(
            platform + " production boot loads current HLS/Shaka APIs locally"
        );
        const names = [
            "System",
            "Sans serif",
            "Condensed",
            "Handwritten",
            "Classic sans",
            "Serif",
            "Narrow",
        ];
        assert.equal(w.fontFamilyList.length, 7);
        assert.equal(w.fixtureFontOptions().length, 7);
        for (let index = 0; index < names.length; index++) {
            w.settings.fontSize = index;
            w.fixtureApplyFont();
            const option = w.document.createElement("div");
            option.innerHTML = w.fixtureFontOptions()[index];
            assert.equal(option.textContent, names[index]);
            assert.equal(
                w.settings.fontSize,
                index,
                "Saved font index must remain unchanged"
            );
            assert.equal(
                w.document.body.style.fontFamily,
                option.firstElementChild.style.fontFamily
            );
            assert.match(
                w.document.body.style.fontFamily,
                /(?:sans-serif|serif|cursive)/
            );
        }
        pass(platform + " all seven saved font indices map to OS font options");
        const rows = $("#rows");
        assert.equal(rows.html('<button class="entry">One</button>'), rows);
        assert.equal(rows.append('<button class="entry">Two</button>'), rows);
        let count = 0;
        rows.on("click.fixture", ".entry", () => count++);
        rows.find(".entry").first().trigger("click");
        rows.off(".fixture");
        rows.find(".entry").last().trigger("click");
        assert.equal(count, 1);
        assert.equal(rows.find(".entry").length, 2);
        rows.hide()
            .show()
            .css({ height: "30px", width: "140px" })
            .toggleClass("active", true);
        assert.equal(rows.hasClass("active"), true);
        assert.equal(rows[0].style.height, "30px");
        const untrusted = '<img src=x onerror="window.untrusted=true">';
        rows.find(".entry").first().text(untrusted);
        assert.equal(rows.find("img").length, 0);
        assert.equal(rows.find(".entry").first().text(), untrusted);
        pass(
            platform +
                " jQuery4 rendering, event cleanup and chain return contract"
        );
        w.eval(compile(read("src/plugins/native-http.ts")));
        const calls = [];
        let reply = () => ({
            body: '{"epg_data":[{"name":"Fixture"}]}',
            headers: "Content-Type: application/json\r\nX-Fixture: yes\r\n",
            status: 200,
            statusText: "OK",
        });
        const transport = async (args) => {
            calls.push(args);
            return reply(args);
        };
        if (platform === "tauri")
            w.installTauriHttpTransport($, (_command, args) => transport(args));
        else {
            w.Capacitor = { isNativePlatform: () => true };
            w.installCapacitorHttpTransport($, { httpRequest: transport });
        }
        const order = [];
        const request = $.ajax("https://native-fixture.invalid/epg", {
            complete() {
                order.push("complete");
            },
            data: { ids: [1, 2], name: "A + Б" },
            dataType: "json",
            success() {
                order.push("success");
            },
        });
        const result = await jqResult(request);
        assert.equal(result.ok, true);
        assert.equal(result.data.epg_data[0].name, "Fixture");
        assert.equal(result.request, request);
        assert.equal(request.getResponseHeader("X-Fixture"), "yes");
        assert.deepEqual(order, ["success", "complete"]);
        const parsed = new URL(calls[0].url);
        assert.equal(parsed.searchParams.get("name"), "A + Б");
        assert.deepEqual(parsed.searchParams.getAll("ids[]"), ["1", "2"]);
        reply = (args) => {
            const callback = new URL(args.url).searchParams.get("callback");
            return {
                body: callback + '({"epg_data":[{"name":"JSONP fixture"}]});',
                headers: "Content-Type: application/javascript\r\n",
                status: 200,
                statusText: "OK",
            };
        };
        const jsonp = await jqResult(
            $.ajax({
                dataType: "jsonp",
                url: "https://native-fixture.invalid/epg.jsonp",
            })
        );
        assert.equal(jsonp.ok, true);
        assert.equal(jsonp.data.epg_data[0].name, "JSONP fixture");
        assert.equal(
            w[new URL(calls.at(-1).url).searchParams.get("callback")],
            undefined,
            "JSONP callback must be cleaned up"
        );
        reply = () => ({
            body: "#EXTM3U\n",
            headers: "Content-Type: text/plain\r\n",
            status: 200,
            statusText: "OK",
        });
        const proxied = await jqResult(
            $.ajax({
                data: {
                    ua: "Fixture UA",
                    url: "https://native-fixture.invalid/list?q=A + Б",
                },
                dataType: "text",
                type: "POST",
                url: "/m3u/cp.php",
            })
        );
        assert.equal(proxied.data, "#EXTM3U\n");
        assert.equal(calls.at(-1).method, "GET");
        assert.equal(
            calls.at(-1).url,
            "https://native-fixture.invalid/list?q=A + Б"
        );
        assert.equal(calls.at(-1).headers["User-Agent"], "Fixture UA");
        pass(
            platform +
                " jQuery4 explicit JSONP cleanup and cp.php form-envelope contract"
        );
        reply = () => ({
            body: "invalid-json",
            headers: "Content-Type: application/json\r\n",
            status: 200,
            statusText: "OK",
        });
        assert.equal(
            (
                await jqResult(
                    $.ajax({
                        dataType: "json",
                        url: "https://native-fixture.invalid/invalid",
                    })
                )
            ).status,
            "parsererror"
        );
        reply = () => ({
            body: '{"message":"denied"}',
            headers: "Content-Type: application/json\r\n",
            status: 403,
            statusText: "Forbidden",
        });
        const denied = await jqResult(
            $.ajax({
                dataType: "json",
                url: "https://native-fixture.invalid/denied",
            })
        );
        assert.equal(denied.ok, false);
        assert.equal(denied.request.status, 403);
        reply = () => new Promise(() => {});
        const pending = $.ajax({ url: "https://native-fixture.invalid/abort" });
        pending.abort();
        assert.equal((await jqResult(pending)).status, "abort");
        pass(
            platform +
                " jQuery4 native AJAX data/converters/status/abort without network"
        );
    } finally {
        w.close();
    }
}
async function main() {
    try {
        for (const [name, platform, play] of [
            ["tauri", "tauri", false],
            ["capacitor-full", "capacitor", false],
            ["capacitor-play", "capacitor", true],
        ]) {
            const folder = fixture(name, play);
            stageNativeRuntime(folder, platform);
            verifyStage(folder, platform);
            await smoke(folder, platform);
        }
        const tauri = path.join(temp, "tauri");
        const blockNotice = path.join(
            tauri,
            "licenses/native/block-0.1.6-LICENSE.txt"
        );
        const blockNoticeBytes = fs.readFileSync(blockNotice);
        fs.rmSync(blockNotice);
        assert.throws(() => auditNativeRuntime(tauri), /block-0\.1\.6-LICENSE/);
        fs.writeFileSync(blockNotice, "incomplete notice");
        assert.throws(
            () => auditNativeRuntime(tauri),
            /copyright and permission/
        );
        fs.writeFileSync(blockNotice, blockNoticeBytes);
        pass(
            "Tauri staging preserves the complete Blocks runtime license notice"
        );
        const core = path.join(tauri, "js/ottplay-core.js");
        const coreBytes = fs.readFileSync(core);
        fs.rmSync(core);
        assert.throws(() => auditNativeRuntime(tauri), /ottplay-core/);
        fs.writeFileSync(core, "/* wrong revision */");
        assert.throws(() => auditNativeRuntime(tauri), /shared core/);
        fs.writeFileSync(core, coreBytes);
        const hls = path.join(tauri, "js/hls.min.js");
        const bytes = fs.readFileSync(hls);
        fs.appendFileSync(hls, "\n/*tampered*/");
        assert.throws(() => auditNativeRuntime(tauri));
        fs.writeFileSync(hls, bytes);
        write(tauri, "unexpected/font.woff2", "font");
        assert.throws(() => auditNativeRuntime(tauri), /Bundled font/);
        fs.rmSync(path.join(tauri, "unexpected"), { recursive: true });
        auditNativeRuntime(tauri);
        pass(
            "artifact gate rejects modified vendor bytes and fonts outside fonts directory"
        );
        const unmapped = fixture("unmapped-icon", true);
        write(unmapped, "dist/unmapped.js", 'var icon = "\\ue000";');
        assert.throws(
            () => stageNativeRuntime(unmapped, "capacitor"),
            /Unmapped Play icon/
        );
        pass("native staging rejects unknown app private-use glyphs");
        assert.deepEqual(
            snapshot(),
            original,
            "Legacy js/fonts source assets were mutated"
        );
        pass("legacy web vendor and font source hashes remain unchanged");
        console.log(
            `Native runtime: ${cases} cases passed; no build/network/device codec test.`
        );
    } finally {
        fs.rmSync(temp, { force: true, recursive: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
