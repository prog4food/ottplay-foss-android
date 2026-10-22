const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const text = fs.readFileSync(path.join(root, "src/core/index.ts"), "utf8");
const source = ts.createSourceFile(
    "index.ts",
    text,
    ts.ScriptTarget.Latest,
    true
);
const selected = new Set([
    "getDefaultPlayerMode",
    "normalizePlayerMode",
    "coreAutoMode",
]);
const functions = source.statements
    .filter((n) => ts.isFunctionDeclaration(n) && selected.has(n.name?.text))
    .map((n) => n.getText(source))
    .join("\n");
const code = ts
    .transpileModule(functions, {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
const context = vm.createContext({
    Hls: undefined,
    isOttplayTestWebView: () => false,
    video: null,
    window: {},
});
vm.runInContext(
    fs.readFileSync(path.join(root, "vendor/ottplay-core.js"), "utf8"),
    context
);
context.window.OttPlayCore = context.OttPlayCore;
vm.runInContext(code, context);
function capture() {
    const output = [];
    for (const webOs of [false, true])
        for (const desktop of [false, true])
            for (const testWebView of [false, true])
                for (const nativeHls of [false, true])
                    for (const hls of [false, true])
                        for (const hasVideo of [false, true]) {
                            context.window.ott_device = webOs
                                ? "lg/webos"
                                : "pc";
                            context.window.__TAURI__ = desktop;
                            context.isOttplayTestWebView = () => testWebView;
                            context.Hls = { isSupported: () => hls };
                            context.video = hasVideo
                                ? {
                                      canPlayType: () =>
                                          nativeHls ? "probably" : "",
                                  }
                                : null;
                            const state = {
                                desktop,
                                hasVideo,
                                hls,
                                nativeHls,
                                testWebView,
                                webOs,
                            };
                            output.push({
                                defaultMode: context.getDefaultPlayerMode(),
                                modes: [-1, 0, 1, 2, 3, 4, 1.5].map((mode) =>
                                    context.normalizePlayerMode(mode)
                                ),
                                state,
                                urls: [
                                    "https://example.test/live.m3u8",
                                    "https://example.test/live.MPD?token=x",
                                    "https://example.test/stream",
                                    "https://example.test/?redirect=live.m3u8",
                                    "https://example.test/?file=track.mpd#section",
                                    "https://example.test/a.m3u8/extra",
                                ].map((url) =>
                                    context.coreAutoMode(url, context.video)
                                ),
                            });
                        }
    return JSON.parse(JSON.stringify(output));
}
const target = path.join(
    __dirname,
    "fixtures/playback-policy/before-core.json"
);
if (process.argv.includes("--capture")) {
    assert(!fs.existsSync(target));
    fs.writeFileSync(
        target,
        JSON.stringify(
            {
                baseline: "b3c8cc072e92f14c8e352a223157788f24ca4dce",
                observed: capture(),
            },
            null,
            2
        ) + "\n"
    );
} else {
    assert.deepEqual(
        capture(),
        JSON.parse(fs.readFileSync(target, "utf8")).observed
    );
    console.log(
        "PASS 64 captured classic playback capability profiles and URL/mode choices"
    );
}
