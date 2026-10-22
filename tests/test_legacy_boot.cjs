const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("parse5");
const { inlineScripts } = require("../scripts/html-scripts.cjs");

assert.deepEqual(
    inlineScripts(
        '<!-- <script>ignored()</script> --><SCRIPT>var a = 1;</script\t\n bar=">">' +
            '<script data-note=">">var b = 2;</script >'
    ),
    ["var a = 1;", "var b = 2;"],
    "The ES5 gate must follow HTML parsing rules for comments, attributes and script end tags"
);

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const runtimeVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../js/media-runtime.json"), "utf8")
).runtimeVersion;
assert.match(runtimeVersion, /^[0-9a-f]{16}$/);
const mediaURL = (name) =>
    "http://legacy-player.test:8080/js/" + name + "?v=" + runtimeVersion;
const scripts = inlineScripts(html);
assert(scripts.length > 0, "The real HTML boot script must be exercised");
const bootScripts = [];
function collectScripts(node) {
    if (node.tagName === "script") {
        bootScripts.push({
            src: node.attrs.find((attr) => attr.name === "src")?.value,
            text: (node.childNodes || [])
                .map((child) => child.value || "")
                .join(""),
        });
    }
    for (const child of node.childNodes || []) collectScripts(child);
}
collectScripts(parse(html));
assert.equal(
    bootScripts[0].src,
    "/js/runtime-polyfills.js?v=" + runtimeVersion,
    "Runtime support must load before every third-party and boot script"
);

function boot(options = {}) {
    const requests = [];
    const styles = [];
    const storage = options.storage || {};
    const storageWrites = [];
    const elements = {};
    const stoppedTimers = [];
    const timers = new Map();
    const messages = [];
    let timerId = 10;
    let languageTag;
    let starts = 0;
    let context;
    const document = {
        body: { className: "booting", style: {} },
        cookie: options.cookie || "",
        createElement(tagName) {
            return { style: {}, tagName };
        },
        getElementById(id) {
            return (elements[id] ||= {
                getAttribute() {
                    return null;
                },
                style: {},
                get textContent() {
                    return this.text || "";
                },
                set textContent(text) {
                    this.text = text;
                    messages.push({ id, text });
                },
            });
        },
        getElementsByTagName() {
            return [this.head];
        },
    };
    document.head = {
        appendChild(tag) {
            if (tag.tagName === "link" && tag.rel === "stylesheet")
                styles.push(tag.href);
            if (tag.tagName !== "script") return;
            requests.push(tag.src);
            const requestPath = new URL(tag.src).pathname;
            const name = requestPath.slice(requestPath.lastIndexOf("/") + 1);
            if (name === "runtime-polyfills.js") {
                if (!options.polyfillsFailure) {
                    if (options.realLibraries)
                        vm.runInContext(
                            fs.readFileSync(
                                path.join(__dirname, "../js", name),
                                "utf8"
                            ),
                            context,
                            { filename: name }
                        );
                    else {
                        context.__ottRuntimePolyfillsReady = true;
                        context.__ottMediaRuntimeVersion = runtimeVersion;
                    }
                } else if (options.polyfillsFailure === "partial") {
                    // A script can fire onload even after an uncaught exception.
                    context.__ottRuntimePolyfillsReady = false;
                } else if (options.polyfillsFailure === "missing-version") {
                    context.__ottRuntimePolyfillsReady = true;
                }
                if (typeof tag.onload === "function") tag.onload();
                return;
            }
            if (requestPath.startsWith("/locales/")) {
                languageTag = tag;
                if (options.languageFailure)
                    tag.onerror(new Error("Missing locale"));
                else if (!options.stalledLanguage) finishLanguage();
                return;
            }
            if (name === "ottplay-core.js") {
                if (options.libraryFailures?.includes(name)) {
                    tag.onerror(new Error("Missing core"));
                    return;
                }
                if (options.realLibraries) {
                    vm.runInContext(
                        fs.readFileSync(
                            path.join(__dirname, "../vendor/ottplay-core.js"),
                            "utf8"
                        ),
                        context
                    );
                    assert.equal(
                        context.OttPlayCore.nativeGuideName("First HD", "web"),
                        "first"
                    );
                } else if (!options.missingCoreGlobal)
                    context.OttPlayCore = {
                        LegacyStalkerClient: function () {},
                        legacyGuideCacheRead: function () {},
                        legacyGuideSelection: function () {},
                        legacyXtreamClient: function () {},
                        NativeGuide: function () {},
                        parseOperatorPlaylist: function () {},
                        parsePlaylistMedia: function () {},
                        parseProviderPlaylist: function () {},
                        providerArchiveUrl: function () {},
                        StalkerClient: function () {},
                        XtreamClient: function () {},
                    };
                if (typeof tag.onload === "function") tag.onload();
                return;
            }
            assert.equal(
                context.__ottRuntimePolyfillsReady,
                true,
                "Third-party scripts must not run before runtime support finishes"
            );
            assert.equal(context.__ottMediaRuntimeVersion, runtimeVersion);
            if (options.libraryFailures?.includes(name)) {
                tag.onerror(new Error("Local library unavailable"));
                return;
            }
            if (
                options.realLibraries &&
                /^(hls.min.js|shaka-player.compiled.js)$/.test(name)
            ) {
                vm.runInContext(
                    fs.readFileSync(
                        path.join(__dirname, "../js", name),
                        "utf8"
                    ),
                    context,
                    { filename: name }
                );
                if (typeof tag.onload === "function") tag.onload();
                return;
            }
            if (/\/jquery(?:-1\.11\.1)?\.min\.js$/.test(tag.src))
                context.jQuery = {};
            else if (tag.src.indexOf("hls.min.js") !== -1) {
                if (!options.missingHlsGlobal) {
                    context.Hls = function Hls() {};
                    context.Hls.DefaultConfig = {};
                }
            } else if (tag.src.indexOf("shaka-player.compiled.js") !== -1)
                context.shaka = { Player() {} };
            else if (tag.src.indexOf("/dist/player.js?") !== -1)
                context.startPlayer = function () {
                    starts++;
                };
            if (typeof tag.onload === "function") tag.onload();
        },
    };
    document.body.appendChild = document.head.appendChild;
    context = vm.createContext({
        clearInterval(timer) {
            stoppedTimers.push(timer);
        },
        clearTimeout(timer) {
            timers.delete(timer);
        },
        console,
        document,
        localStorage: {
            getItem(key) {
                if (options.storageError === "read")
                    throw new Error("SecurityError");
                return storage[key] || null;
            },
            setItem(key, value) {
                storageWrites.push([key, value]);
                if (options.storageError === "write")
                    throw new Error("QuotaExceededError");
                storage[key] = value;
            },
        },
        // location.origin and DOM classList are deliberately missing in the legacy fixture.
        location: {
            host: "legacy-player.test:8080",
            pathname: options.pathname || "/",
            protocol: "http:",
        },
        navigator: {
            userAgent:
                options.userAgent ??
                (options.device === "pc" ? "OldUnknownBrowser" : "Hisense TV"),
        },
        setInterval() {
            return 1;
        },
        setTimeout(callback, delay) {
            timers.set(++timerId, { callback, delay });
            return timerId;
        },
        URL: Object.assign(function URL() {}, { createObjectURL() {} }),
    });
    context.window = context;
    context.self = context;
    Object.defineProperties(
        context,
        Object.getOwnPropertyDescriptors(options.globals || {})
    );
    Object.defineProperties(
        context.navigator,
        Object.getOwnPropertyDescriptors(options.navigator || {})
    );
    const blobURLApi = {
        createObjectURL() {
            assert.equal(this.marker, "native-blob-provider");
            return "blob:legacy-player.test/runtime-check";
        },
        marker: "native-blob-provider",
        revokeObjectURL(url) {
            assert.equal(this.marker, "native-blob-provider");
            assert.equal(url, "blob:legacy-player.test/runtime-check");
        },
    };
    if (options.objectValuedURL) context.URL = blobURLApi;
    else Object.assign(context.URL, blobURLApi);
    if (options.storageError === "access") {
        Object.defineProperty(context, "localStorage", {
            get() {
                throw new Error("SecurityError");
            },
        });
    }
    if (options.noObjectURL) context.URL = undefined;
    if (options.webkitURL) context.webkitURL = blobURLApi;
    if (options.noDateNow) vm.runInContext("Date.now = undefined;", context);
    if (options.modern) {
        context.crypto = {
            getRandomValues(bytes) {
                for (let i = 0; i < bytes.length; i++) bytes[i] = i + 16;
                return bytes;
            },
        };
    }
    if (!options.modern) {
        vm.runInContext(
            `
            Array.from = undefined;
            Promise = undefined;
            Uint8Array = undefined;
            crypto = undefined;
            Map = undefined;
            Set = undefined;
            Symbol = undefined;
            Object.assign = undefined;
            String.prototype.includes = undefined;
            Math.imul = undefined;
        `,
            context
        );
    }
    function finishLanguage() {
        const name = new URL(languageTag.src).pathname.split("/").pop();
        vm.runInContext(
            fs.readFileSync(path.join(__dirname, "../locales", name), "utf8"),
            context
        );
        languageTag.onload();
    }
    for (const script of bootScripts) {
        if (script.src) {
            document.head.appendChild({
                src: new URL(script.src, "http://legacy-player.test:8080/")
                    .href,
                tagName: "script",
            });
        } else
            vm.runInContext(
                options.version
                    ? script.text.replace(
                          /__OTTP_VERSION__|__OTTP_ASSET_VERSION__/g,
                          options.version
                      )
                    : script.text,
                context,
                {
                    filename: "index.html boot",
                }
            );
    }
    if (options.stalledLanguage) {
        assert.equal(
            starts,
            0,
            "Player waits for the saved catalog before booting"
        );
        [...timers.values()].find((timer) => timer.delay === 2500).callback();
    }
    assert.equal(
        starts,
        options.polyfillsFailure ||
            options.missingCoreGlobal ||
            options.libraryFailures?.some((name) =>
                /^jquery|^ottplay-core/.test(name)
            )
            ? 0
            : 1,
        "Boot must start once, or present a recoverable runtime/UI load failure"
    );
    if (options.version) {
        assert.equal(context.__cv, options.version);
        assert.equal(context.__av, options.version);
    } else {
        assert.match(context.__cv, /^dev_\d+_[0-9a-f]{8}$/);
        assert.match(context.__av, /^dev_\d+_[0-9a-f]{8}$/);
    }
    if (options.modern && !options.storage)
        assert.match(context.deviceUUID, /^dev_[0-9a-f]{32}$/);
    assert.equal(
        context.host,
        "http://legacy-player.test:8080",
        "Origin fallback retains the remote host"
    );
    if (
        context.deviceUUID &&
        options.storageError !== "write" &&
        options.storageError !== "access"
    )
        assert.equal(storage.ott_device_uuid, context.deviceUUID);
    else assert.equal(storage.ott_device_uuid, undefined);
    return {
        context,
        elements,
        finishLanguage,
        messages,
        requests,
        stoppedTimers,
        storage,
        storageWrites,
        styles,
    };
}

// Exercise the same version substitution as packaged HTML on an old engine.
for (const version of ["1.1.52-beta.6", "1.1.52-beta.7", "1.1.52", "1.1.53"]) {
    const first = boot({ version });
    const reload = boot({ version });
    assert.deepEqual(
        first.requests,
        reload.requests,
        "One release reuses script cache keys"
    );
    assert.deepEqual(
        first.styles,
        reload.styles,
        "One release reuses stylesheet cache keys"
    );
    assert.deepEqual(
        first.requests.map((url) => new URL(url).pathname),
        [
            "/js/runtime-polyfills.js",
            "/js/ottplay-core.js",
            "/js/jquery-1.11.1.min.js",
            "/js/hls.min.js",
            "/js/shaka-player.compiled.js",
            "/dist/player.js",
            "/devices/hisense/device.js",
        ],
        "Versioned caching preserves dependency execution order"
    );
    for (const pathname of [
        "/js/ottplay-core.js",
        "/dist/player.js",
        "/devices/hisense/device.js",
    ]) {
        assert(
            first.requests.includes(
                "http://legacy-player.test:8080" + pathname + "?" + version
            )
        );
    }
    assert(
        first.styles.includes(
            "http://legacy-player.test:8080/styles/player.css?" + version
        )
    );
    for (const failure of [
        { polyfillsFailure: "network" },
        { libraryFailures: ["ottplay-core.js"] },
        { libraryFailures: ["jquery-1.11.1.min.js"] },
    ]) {
        const failed = boot({ ...failure, version });
        assert(
            !failed.requests.some((url) => url.includes("/dist/player.js?")),
            "A failed dependency never executes the player"
        );
    }
}

// A recognized TV and an unknown old STB both boot with no ES2015 APIs or WebCrypto.
for (const device of ["hisense", "pc"]) {
    const result = boot({ device });
    assert(
        result.requests.every(
            (url) => url.indexOf("http://legacy-player.test:8080/") === 0
        )
    );
    assert(result.requests.includes(mediaURL("hls.min.js")));
    assert(
        result.requests.some((url) =>
            url.endsWith("/js/shaka-player.compiled.js")
        )
    );
    assert(
        result.requests.some((url) => url.endsWith("/js/jquery-1.11.1.min.js"))
    );
    assert(
        result.requests.some((url) =>
            url.includes(`/devices/${device}/device.js?`)
        )
    );
    assert.equal(
        result.context.deviceUUID,
        "",
        "Missing crypto must not create a weak remote-access credential"
    );
    const oldId = "dev_existing-installation";
    assert.equal(
        boot({ device, storage: { ott_device_uuid: oldId } }).context
            .deviceUUID,
        oldId,
        "Existing installation identity survives on engines without crypto"
    );
}

// Platform detection chooses the device adapter, never a different HLS release.
const androidWebViewUA =
    "Mozilla/5.0 (Linux; Android 16; SDK TV; wv) AppleWebKit/537.36 " +
    "Version/4.0 Chrome/143.0.7499.24 Safari/537.36";
const testWebViewUA = androidWebViewUA + " OttplayTestWebView/1.0";
for (const options of [
    { device: "pc" },
    { device: "pc", modern: false },
    { userAgent: androidWebViewUA },
    { userAgent: testWebViewUA },
    { userAgent: androidWebViewUA + " NotOttplayTestWebView/1.0" },
    { userAgent: testWebViewUA + "1" },
    { modern: false, userAgent: testWebViewUA },
    { globals: { Capacitor: {} }, userAgent: testWebViewUA },
    { globals: { Android: {} }, userAgent: testWebViewUA },
    { globals: { __ottNativeRuntime: {} }, userAgent: testWebViewUA },
    { globals: { __TAURI__: {} }, userAgent: testWebViewUA },
    { globals: { __TAURI_INTERNALS__: {} }, userAgent: testWebViewUA },
    { pathname: "/f/lg/webos/", userAgent: testWebViewUA },
]) {
    const result = boot({ modern: true, ...options });
    const local = (name) => "http://legacy-player.test:8080/js/" + name;
    assert.equal(result.requests[0], mediaURL("runtime-polyfills.js"));
    assert(result.requests[1].startsWith(local("ottplay-core.js?")));
    assert.equal(
        result.requests[2],
        local(
            options.globals?.__ottNativeRuntime
                ? "jquery.min.js"
                : "jquery-1.11.1.min.js"
        )
    );
    assert.equal(result.requests[3], mediaURL("hls.min.js"));
    assert.equal(result.requests[4], local("shaka-player.compiled.js"));
    assert(result.requests[5].includes("/dist/player.js?"));
    assert.equal(
        result.context.Hls.DefaultConfig.workerPath,
        mediaURL("hls.worker.js")
    );
    assert(
        !result.requests.some(
            (url) => new URL(url).hostname === "cdn.jsdelivr.net"
        )
    );
}
// A preloaded HLS constructor must receive the same worker configuration.
const preloadedHls = function Hls() {};
preloadedHls.DefaultConfig = {};
const preloaded = boot({ globals: { Hls: preloadedHls, jQuery: {} } });
assert.equal(preloadedHls.DefaultConfig.workerPath, mediaURL("hls.worker.js"));
assert(!preloaded.requests.includes(mediaURL("hls.min.js")));

for (const options of [
    { libraryFailures: ["hls.min.js"] },
    { missingHlsGlobal: true },
    { libraryFailures: ["shaka-player.compiled.js"] },
    { libraryFailures: ["hls.min.js", "shaka-player.compiled.js"] },
]) {
    const result = boot(options);
    assert.match(result.elements["boot-log"].textContent, /→ HTML5/);
    assert(
        result.requests.some((url) =>
            url.includes("/devices/hisense/device.js?")
        )
    );
}
for (const polyfillsFailure of ["network", "partial", "missing-version"]) {
    const result = boot({ polyfillsFailure });
    assert.deepEqual(result.requests, [mediaURL("runtime-polyfills.js")]);
    assert.equal(
        result.elements["boot-status"].textContent,
        "Compatibility runtime could not load. Reopen the player to retry."
    );
    assert.match(
        result.elements["boot-log"].textContent,
        /js\/runtime-polyfills\.js/
    );
    assert.equal(result.context.document.body.className, "");
    assert(
        result.stoppedTimers.includes(1),
        "A failed runtime load must stop the loading animation"
    );
}
console.log(
    "OK: polyfills load first, unified local HLS and worker, visible failure and device playback fallback"
);

// LG's Web0S token uses a zero and does not require an LG vendor marker.
const lgWeb0SUserAgent =
    "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager";
for (const userAgent of [
    lgWeb0SUserAgent,
    "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.41 " +
        "(KHTML, like Gecko) Large Screen WebAppManager",
    "Mozilla/5.0 (webOS; Linux/SmartTV) AppleWebKit/537.36",
    "Mozilla/5.0 (LG SmartTV) AppleWebKit/537.36",
]) {
    for (const modern of [false, true]) {
        const result = boot({ modern, userAgent });
        assert.equal(
            result.context.ott_device,
            "lg/webos",
            "LG browser must select webOS without an explicit device route"
        );
        assert(
            result.requests.some((url) =>
                url.includes("/devices/lg/webos/device.js?")
            ),
            "LG boot must request the webOS remote and playback adapter"
        );
        assert(
            result.requests.includes(mediaURL("hls.min.js")),
            "LG boot must retain the local TV library path even with modern APIs"
        );
        assert(
            !result.requests.some(
                (url) => new URL(url).hostname === "cdn.jsdelivr.net"
            ),
            "LG must use the same local libraries as every other device"
        );
    }
}

// Explicit device routes must preserve both components of nested vendor IDs.
for (const device of [
    "lg/webos",
    "lg/netcast",
    "samsung/tizen",
    "samsung/maple",
    "dune",
    "mag",
    "pc",
]) {
    for (const suffix of ["/", "/index.html", "/nested/index.html", ""]) {
        for (const userAgent of ["OldUnknownBrowser", lgWeb0SUserAgent]) {
            const result = boot({
                pathname: "/f/" + device + suffix,
                userAgent,
            });
            assert.equal(
                result.context.ott_device,
                device,
                "Explicit device route must override browser detection"
            );
            assert(
                result.requests.some((url) =>
                    url.includes("/devices/" + device + "/device.js?")
                ),
                "The requested adapter must retain the complete route platform"
            );
        }
    }
}
console.log(
    "OK: LG Web0S/webOS detection and explicit nested device route precedence"
);

// Storage policy and quota errors must not abort basic boot or replace secure RNG.
for (const storageError of ["access", "read", "write"]) {
    const result = boot({ modern: true, noDateNow: true, storageError });
    assert.match(result.context.deviceUUID, /^dev_[0-9a-f]{32}$/);
}
// Execute the actual vendor payloads, not a fake successful script download.
for (const options of [
    { realLibraries: true },
    { objectValuedURL: true, realLibraries: true },
    { noObjectURL: true, realLibraries: true },
    { noObjectURL: true, realLibraries: true, webkitURL: true },
]) {
    const result = boot(options);
    assert.equal(typeof result.context.Hls, "function");
    assert.equal(result.context.Hls.version, "1.7.3");
    assert.equal(
        result.context.Hls.DefaultConfig.workerPath,
        mediaURL("hls.worker.js")
    );
    if (options.noObjectURL && !options.webkitURL) {
        assert(
            !result.requests.some((url) =>
                url.endsWith("/js/shaka-player.compiled.js")
            )
        );
    } else {
        assert.equal(typeof result.context.shaka.Player, "function");
        const blobURL = result.context.URL.createObjectURL({});
        assert.equal(blobURL, "blob:legacy-player.test/runtime-check");
        result.context.URL.revokeObjectURL(blobURL);
    }
}
console.log(
    "OK: denied/quota storage, pre-bundle Date.now and actual old-API vendor payloads"
);

for (const options of [
    { libraryFailures: ["ottplay-core.js"] },
    { missingCoreGlobal: true },
]) {
    const result = boot(options);
    assert.equal(
        result.elements["boot-status"].textContent,
        "Player could not start"
    );
    assert.equal(
        result.requests.length,
        2,
        "A broken core must not start the player"
    );
}

// Real dictionaries are available even when the runtime/core cannot load.
const {
    languageAssets,
    readDictionary,
} = require("../scripts/localization-catalog.cjs");
for (const [code, asset] of Object.entries(languageAssets)) {
    const result = boot({ storage: { ottplaylang: code } });
    const dictionary = readDictionary(path.join(__dirname, "..", asset));
    assert(
        result.requests.some((url) => new URL(url).pathname === asset),
        code + " uses canonical locale filename"
    );
    assert.equal(
        result.elements["boot-status"].textContent,
        dictionary["Starting..."]
    );
    assert.equal(result.context.__ottBootLanguage.code, code);
    assert.equal(result.context.__ottBootLanguage.automatic, false);
    assert.equal(
        result.context.__ottBootLanguage.dictionary,
        result.context.keyStrings
    );
    assert.deepEqual(
        result.messages
            .filter((entry) => entry.id === "boot-status")
            .map((entry) => entry.text),
        [
            "Starting...",
            "Loading interface...",
            "Loading media libraries...",
            "Loading player...",
            "Loading device...",
            "Starting...",
        ].map((key) => dictionary[key])
    );
}
for (const globals of [
    {},
    { __ottNativeRuntime: true, __TAURI__: {} },
    { __ottNativeRuntime: true, Capacitor: {} },
]) {
    const result = boot({
        globals,
        polyfillsFailure: "network",
        storage: { ottplaylang: "_rus" },
    });
    assert.match(result.elements["boot-status"].textContent, /^Не удалось/);
    assert.equal(
        result.requests.length,
        2,
        "Locale loads independently of runtime support"
    );
}
const cookieLanguage = boot({
    cookie: "other=x; ottplaylang=_rus",
    storageError: "read",
});
assert.equal(cookieLanguage.elements["boot-status"].textContent, "Запуск…");
const clearedLanguage = boot({ cookie: "ottplaylang=_rus" });
assert(
    !clearedLanguage.requests.some((url) => url.includes("/locales/")),
    "A cleared localStorage preference beats stale cookies"
);
for (const code of [
    "constructor",
    "__proto__",
    "../../private",
    "_not_a_language",
])
    assert(
        !boot({ storage: { ottplaylang: code } }).requests.some((url) =>
            url.includes("/locales/")
        )
    );
const missingLocale = boot({
    languageFailure: true,
    storage: { ottplaylang: "_rus" },
});
assert.equal(missingLocale.elements["boot-status"].textContent, "Starting...");
const stalledLocale = boot({
    stalledLanguage: true,
    storage: { ottplaylang: "_rus" },
});
const laterDictionary = { "Starting...": "Démarrage…" };
stalledLocale.context.keyStrings = stalledLocale.context.__ottBootDictionary =
    laterDictionary;
stalledLocale.finishLanguage();
assert.equal(
    stalledLocale.context.keyStrings,
    laterDictionary,
    "Late bootstrap locale cannot replace the player's newer dictionary"
);
assert.equal(missingLocale.context.__ottBootLanguage, undefined);
assert.equal(stalledLocale.context.__ottBootLanguage, undefined);

// Exercise the production detector and the real dictionaries, without Intl or
// modern runtime helpers. The pinned CLDR fixture is independent of its maps.
const startupLocales = JSON.parse(
    fs.readFileSync(
        path.join(__dirname, "fixtures/startup-locales.json"),
        "utf8"
    )
);
assert.deepEqual(
    Object.values(startupLocales.languages)
        .map((entry) => entry.code)
        .sort(),
    Object.keys(languageAssets).sort(),
    "Automatic detection covers every shipped interface language"
);
const profiles = [
    {},
    { __ottNativeRuntime: true, __TAURI__: {} },
    { __ottNativeRuntime: true, Capacitor: {} },
];
function detectedLanguage(options, code, automatic = true) {
    const result = boot(options);
    const languageRequests = result.requests.filter((url) =>
        new URL(url).pathname.startsWith("/locales/")
    );
    assert.deepEqual(
        languageRequests.map((url) => new URL(url).pathname),
        [languageAssets[code]],
        "Only the selected canonical dictionary loads: " + code
    );
    const selected = result.context.__ottBootLanguage;
    assert.equal(selected.code, code);
    assert.equal(selected.automatic, automatic);
    assert.equal(selected.dictionary, result.context.keyStrings);
    assert.equal(selected.dictionary, result.context.__ottBootDictionary);
    assert.equal(
        result.elements["boot-status"].textContent,
        readDictionary(path.join(__dirname, "..", languageAssets[code]))[
            options.polyfillsFailure
                ? "Compatibility runtime could not load. Reopen the player to retry."
                : "Starting..."
        ]
    );
    assert.deepEqual(
        result.storageWrites.filter(([key]) => key === "ottplaylang"),
        [],
        "Early preloading never commits a language preference"
    );
    if (automatic && !(options.storage && options.storage.ottplaylang))
        assert.equal(result.storage.ottplaylang || "", "");
    return result;
}
function undetectedLanguage(options) {
    const result = boot(options);
    assert.equal(result.context.__ottBootLanguage, undefined);
    assert(
        !result.requests.some((url) =>
            new URL(url).pathname.startsWith("/locales/")
        ),
        "Unsupported preferences stay unselected instead of loading English"
    );
    assert.deepEqual(
        result.storageWrites.filter(([key]) => key === "ottplaylang"),
        []
    );
    return result;
}
for (const globals of profiles) {
    for (const [tag, { code, script }] of Object.entries(
        startupLocales.languages
    )) {
        for (const language of [
            tag,
            tag + "-001",
            tag.toUpperCase() + "_" + script + "_001",
        ])
            detectedLanguage(
                { globals, navigator: { languages: [language] } },
                code
            );
    }
    detectedLanguage(
        { globals, navigator: { languages: ["zz-ZZ", "pt-BR", "ru-RU"] } },
        "_por"
    );
    detectedLanguage(
        {
            globals: { ...globals, __ottPreferredLanguages: ["en-US"] },
            navigator: { languages: ["fr-FR"] },
            storage: { ottplaylang: "_rus" },
        },
        "_rus",
        false
    );
    detectedLanguage(
        {
            globals: {
                ...globals,
                __ottPreferredLanguages: ["ckb-IQ", "ru-RU", "fr-FR"],
            },
            navigator: { languages: ["en-US"] },
        },
        "_rus"
    );
    undetectedLanguage({
        globals,
        navigator: { language: "en-US", languages: ["ckb-IQ", "nn-NO"] },
    });
    undetectedLanguage({
        globals: { ...globals, __ottPreferredLanguages: ["ckb-IQ", "nn-NO"] },
        navigator: { language: "en-US", languages: ["en-US"] },
    });
}
for (const [tag, regionalScript] of Object.entries(
    startupLocales.regionalScripts
)) {
    const [base] = tag.split("-");
    const { code, script } = startupLocales.languages[base];
    assert.notEqual(regionalScript, script.toLowerCase());
    undetectedLanguage({ navigator: { language: "en-US", languages: [tag] } });
    detectedLanguage(
        {
            navigator: {
                languages: [base + "-" + script + "-" + tag.split("-")[1]],
            },
        },
        code
    );
}
for (const language of [
    "zh-Hant",
    "zh-TW",
    "pa-Arab",
    "pa-PK",
    "sr-Latn",
    "uz-Cyrl",
    "ckb",
    "nn",
])
    undetectedLanguage({
        navigator: { language: "en-US", languages: [language] },
    });
for (const [language, code] of Object.entries({
    in: "_ind",
    iw: "_heb",
    kmr: "_kur",
    mo: "_rou",
    nb: "_nor",
    tl: "_fil",
}))
    detectedLanguage({ navigator: { languages: [language] } }, code);
detectedLanguage({ navigator: { languages: ["ru-RU-u-nu-latn"] } }, "_rus");
undetectedLanguage({
    navigator: { language: "zh", languages: ["zh-TW-u-ca-chinese"] },
});

// Only a nonempty array is authoritative; older devices may expose only one
// legacy property. An unsupported preferred list must not silently use English.
for (const languages of [
    undefined,
    null,
    [],
    "fr-FR",
    { 0: "fr-FR", length: 1 },
])
    detectedLanguage({ navigator: { language: "RU_ru", languages } }, "_rus");
detectedLanguage(
    {
        navigator: {
            browserLanguage: "fr-FR",
            language: "zz",
            userLanguage: "uk-UA",
        },
    },
    "_ukr"
);
detectedLanguage(
    {
        navigator: {
            browserLanguage: "fr-FR",
            language: "zz",
            userLanguage: "zz",
        },
    },
    "_fra"
);
detectedLanguage(
    { navigator: { language: "ru-RU", languages: ["fr-FR"] } },
    "_fra"
);
for (const preferred of [
    undefined,
    null,
    [],
    "fr-FR",
    { 0: "fr-FR", length: 1 },
])
    detectedLanguage(
        {
            globals: { __ottPreferredLanguages: preferred },
            navigator: { languages: ["ru-RU"] },
        },
        "_rus"
    );
undetectedLanguage({});
undetectedLanguage({
    navigator: {
        languages: [
            "constructor",
            "__proto__",
            "../../private",
            "en/US",
            "en--US",
            "",
            42,
            {},
            null,
        ],
    },
});
detectedLanguage({ navigator: { languages: [null, 42, {}, "ru-RU"] } }, "_rus");
detectedLanguage(
    {
        globals: {
            get __ottPreferredLanguages() {
                throw new Error("Unavailable native preferences");
            },
        },
        navigator: {
            language: "ru-RU",
            get languages() {
                throw new Error("Unavailable language list");
            },
        },
    },
    "_rus"
);
detectedLanguage(
    {
        navigator: {
            browserLanguage: "fr-FR",
            get language() {
                throw new Error("Unavailable language");
            },
            get userLanguage() {
                throw new Error("Unavailable user language");
            },
        },
    },
    "_fra"
);

detectedLanguage(
    {
        navigator: { languages: ["fr-FR"] },
        storage: { ottplaylang: "_rus", ottplaylangmode: "system" },
    },
    "_fra"
);
detectedLanguage(
    {
        navigator: { languages: ["fr-FR"] },
        storage: { ottplaylang: "_rus", ottplaylangmode: "manual" },
    },
    "_rus",
    false
);
undetectedLanguage({
    navigator: { languages: ["zh-Hant"] },
    storage: { ottplaylang: "_rus", ottplaylangmode: "system" },
});
detectedLanguage(
    {
        cookie: "ottplayStorageFallback=%5B%22ottplaylang%22%5D; ottplaylang=_rus",
        navigator: { languages: ["fr-FR"] },
        storage: { ottplaylang: "_eng" },
    },
    "_rus",
    false
);
detectedLanguage(
    {
        cookie: "ottplayStorageFallback=%5B%22ottplaylangmode%22%5D; ottplaylangmode=system",
        navigator: { languages: ["fr-FR"] },
        storage: { ottplaylang: "_eng", ottplaylangmode: "manual" },
    },
    "_fra"
);

// Exercise the actual ES5 storage writer against a silent 4096-byte cookie
// limit, then feed its persisted bytes into the real early boot script.
for (const storageError of [undefined, "access", "read"])
    detectedLanguage(
        {
            cookie: "ottplayStorageFallback.reset=1; ottplayStorageFallback=%5B%5D; ottplaylang=_rus",
            navigator: { languages: ["fr-FR"] },
            storageError,
        },
        "_fra"
    );
detectedLanguage(
    {
        cookie: "ottplayStorageFallback.reset=1; ottplayStorageFallback=%5B%22ottplaylang%22%5D; ottplaylang=_rus",
        navigator: { languages: ["fr-FR"] },
    },
    "_rus",
    false
);

function chunkedBootCookies(rejected) {
    const cookies = {};
    const saved = { ottplaylang: "_eng", ottplaylangmode: "manual" };
    const document = {};
    Object.defineProperty(document, "cookie", {
        get() {
            return Object.keys(cookies)
                .map((key) => key + "=" + cookies[key])
                .join("; ");
        },
        set(value) {
            if (
                Buffer.byteLength(value) > 4096 ||
                (rejected && rejected(value))
            )
                return;
            const pair = value.split(";")[0],
                equals = pair.indexOf("="),
                name = pair.slice(0, equals);
            if (value.includes("1970")) delete cookies[name];
            else cookies[name] = pair.slice(equals + 1);
        },
    });
    const context = vm.createContext({
        document,
        localStorage: {
            getItem(key) {
                return Object.hasOwn(saved, key) ? saved[key] : null;
            },
            key(index) {
                return Object.keys(saved)[index];
            },
            get length() {
                return Object.keys(saved).length;
            },
            setItem() {
                throw new Error("QuotaExceededError");
            },
        },
    });
    context.window = context;
    const ts = require("typescript");
    vm.runInContext(
        ts.transpileModule(
            fs
                .readFileSync(
                    path.join(__dirname, "../src/storage/index.ts"),
                    "utf8"
                )
                .replace(/^export\s+/gm, ""),
            {
                compilerOptions: {
                    module: ts.ModuleKind.None,
                    target: ts.ScriptTarget.ES5,
                },
            }
        ).outputText,
        context
    );
    for (let i = 0; i < 8; i++)
        context.storage.set(
            "provider:" + i + ":" + "設定🎬".repeat(80),
            "value"
        );
    context.storage.set("ottplaylang", "_rus");
    context.storage.set("ottplaylangmode", "manual");
    return cookies;
}
const marker = "ottplayStorageFallback";
const chunkedCookies = chunkedBootCookies();
assert(JSON.parse(decodeURIComponent(chunkedCookies[marker])).n > 1);
const cookieHeader = (cookies) =>
    Object.keys(cookies)
        .map((key) => key + "=" + cookies[key])
        .join("; ");
function expectChunkedLanguage(cookies, language = "_rus", automatic = false) {
    detectedLanguage(
        {
            cookie: cookieHeader(cookies),
            navigator: { languages: ["fr-FR"] },
            storage: { ottplaylang: "_eng", ottplaylangmode: "manual" },
        },
        language,
        automatic
    );
}
expectChunkedLanguage(chunkedCookies);
expectChunkedLanguage(
    { ...chunkedCookies, ottplaylangmode: "system" },
    "_fra",
    true
);
for (const corrupt of ["part", "manifest", "percent", "hash", "pending"]) {
    const cookies = { ...chunkedCookies };
    if (corrupt === "part") delete cookies[marker + ".0"];
    if (corrupt === "manifest") delete cookies[marker];
    if (corrupt === "percent") cookies[marker] = "%ZZ";
    if (corrupt === "hash")
        cookies[marker + ".0"] = encodeURIComponent("mismatched part");
    if (corrupt === "pending") cookies[marker] = "pending";
    expectChunkedLanguage(cookies);
}
expectChunkedLanguage({
    [marker]: encodeURIComponent("[42]"),
    ottplaylang: "_rus",
});
expectChunkedLanguage({ [marker]: "pending" }, "_fra", true);
for (const rejected of [
    (value) => value.startsWith(marker + ".1="),
    (value) => value.startsWith(marker + "=%7B"),
]) {
    const cookies = chunkedBootCookies(rejected);
    assert.equal(cookies[marker], "pending");
    expectChunkedLanguage(cookies);
}

for (const storageError of ["access", "read"])
    detectedLanguage(
        {
            cookie: "ottplaylang=_rus",
            navigator: { languages: ["fr-FR"] },
            storageError,
        },
        "_rus",
        false
    );
detectedLanguage(
    { cookie: "ottplaylang=_rus", navigator: { languages: ["fr-FR"] } },
    "_fra"
);
detectedLanguage(
    {
        cookie: "ottplaylang=%E0%A4%A",
        navigator: { languages: ["fr-FR"] },
        storageError: "read",
    },
    "_fra"
);
detectedLanguage(
    { navigator: { languages: ["fr-FR"] }, storageError: "write" },
    "_fra"
);
for (const code of [
    "constructor",
    "__proto__",
    "../../private",
    "_not_a_language",
])
    undetectedLanguage({
        navigator: { languages: ["en-US"] },
        storage: { ottplaylang: code },
    });

for (const globals of profiles) {
    detectedLanguage(
        {
            globals,
            navigator: { languages: ["ru-RU"] },
            polyfillsFailure: "network",
        },
        "_rus"
    );
    for (const options of [
        { languageFailure: true },
        { stalledLanguage: true },
    ]) {
        const result = boot({
            ...options,
            globals,
            navigator: { languages: ["ru-RU"] },
        });
        assert.equal(result.context.__ottBootLanguage, undefined);
        assert.equal(result.storage.ottplaylang, undefined);
        assert.deepEqual(
            result.storageWrites.filter(([key]) => key === "ottplaylang"),
            []
        );
        if (options.stalledLanguage) {
            const committed = { "Starting...": "Démarrage…" };
            result.context.keyStrings = result.context.__ottBootDictionary =
                committed;
            result.storage.ottplaylang = "_fra";
            result.finishLanguage();
            assert.equal(result.context.keyStrings, committed);
            assert.equal(result.context.__ottBootLanguage, undefined);
            assert.equal(result.storage.ottplaylang, "_fra");
        }
    }
}
console.log(
    "OK: all 88 boot locales, first-run language/script matching, preference precedence, native/runtime failures, cookie fallback and safe timeout settlement"
);
