const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const rust = read("src-tauri/src/preferred_languages.rs");
const swift = read("ios/App/App/MainViewController.swift");
const templates = {
    ios: /source: """\n([\s\S]*?)\n\s*""",/.exec(swift)?.[1],
    tauri: /const SCRIPT_TEMPLATE: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1],
};
const preferences = ["zz-ZZ", "ru-RU", 'x-"\\\n$&'];
function run(platform, origins, url, subframe = false) {
    let script = templates[platform];
    assert(script, platform + " must use its production template");
    script = script
        .replace(/__OTT_LANGUAGE_ORIGINS__|\\\(originsJson\)/, () =>
            JSON.stringify(origins)
        )
        .replace(/__OTT_LANGUAGE_VALUES__|\\\(json\)/, () =>
            JSON.stringify(preferences)
        );
    const location = new URL(url);
    // Custom protocol URLs have an opaque URL.origin in this harness, too.
    // The production script must use their exact protocol and host instead.
    const window = { location };
    window.top = subframe ? {} : window;
    vm.runInNewContext(script, { window });
    return window;
}

for (const platform of ["tauri", "ios"]) {
    const bundled =
        platform === "tauri"
            ? [
                  "tauri://localhost",
                  "http://tauri.localhost",
                  "https://tauri.localhost",
              ]
            : ["capacitor://localhost"];
    const origins = [
        ...bundled,
        "https://custom.example:8443",
        "http://custom.example:8686",
        "http://[::1]:5173",
    ];
    for (const origin of origins) {
        const window = run(platform, origins, origin + "/player?session=ui");
        assert.deepEqual(
            Array.from(window.__ottPreferredLanguages),
            preferences,
            platform + " allowed " + origin
        );
        assert(
            !Object.hasOwn(
                run(platform, origins, origin + "/frame", true),
                "__ottPreferredLanguages"
            ),
            platform + " must exclude even same-origin subframes"
        );
    }
    for (const url of [
        "https://foreign.example/",
        "https://custom.example/",
        "http://custom.example:8443/",
        "https://custom.example:8444/",
        "https://custom.example.evil:8443/",
        "https://custom.example:8443@foreign.example/",
        "http://localhost:5173/",
        "tauri://localhost.evil/",
        "https://tauri.localhost.evil/",
        "capacitor://localhost.evil/",
        "other://localhost/",
        "data:text/html,player",
        "about:blank",
        "file:///player/index.html",
        "blob:https://custom.example:8443/id",
    ]) {
        assert(
            !Object.hasOwn(
                run(platform, origins, url),
                "__ottPreferredLanguages"
            ),
            platform + " leaked preferences to " + url
        );
    }
    assert(
        !Object.hasOwn(
            run(platform, bundled, "https://custom.example:8443/"),
            "__ottPreferredLanguages"
        ),
        platform + " must not implicitly trust an unconfigured server"
    );
}

const entry = read("src-tauri/src/lib.rs");
assert.match(
    entry,
    /#\[cfg\(dev\)\]\s*let dev_url = app\.config\(\)\.build\.dev_url\.as_ref\(\);/
);
assert.match(entry, /#\[cfg\(not\(dev\)\)\]\s*let dev_url = None;/);
assert.match(
    entry,
    /initialization_script\(\s*preferred_languages::initialization_script\(\s*web_url\.as_ref\(\),\s*dev_url,?\s*\)\s*\)/
);
assert.match(
    entry,
    /if let Some\(url\) = web_url\s*\{[\s\S]*?window\.navigate\(url\)/
);
assert.match(
    swift,
    /\[bridge\?\.config\.localURL, bridge\?\.config\.serverURL\]/
);
assert.match(
    swift,
    /injectionTime: \.atDocumentStart,\s*forMainFrameOnly: true/
);
console.log(
    "PASS native language injection: actual Tauri/iOS templates, trusted origins, ports, subframe/foreign/opaque rejection and JSON escaping"
);
