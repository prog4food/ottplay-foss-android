// Use real DOM mutation delivery: preview placement follows the existing
// adapter's inline geometry without wrapping player functions or input events.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const code = fs.readFileSync(
    path.join(root, "js/browser-app/window-controls.js"),
    "utf8"
);
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const bootstrapBlock = html.match(
    /<!-- Browser window controls: start -->([\s\S]*?)<!-- Browser window controls: end -->/
);
assert.ok(bootstrapBlock, "browser bootstrap has an explicit boundary");
const bootstrap = JSDOM.fragment(bootstrapBlock[1]).querySelector(
    "script"
).textContent;
const settle = () => new Promise((resolve) => setImmediate(resolve));
let passed = 0;

async function fixture(options, callback) {
    const dom = new JSDOM(
        '<!doctype html><html class="existing"><body><div id="list"></div></body></html>',
        {
            runScripts: "outside-only",
            url: options.url || "https://example.invalid/f/pc/",
        }
    );
    const w = dom.window;
    const doc = w.document;
    const observations = [];
    const overlay = new w.EventTarget();
    const mode = new w.EventTarget();
    const OriginalObserver = w.MutationObserver;
    overlay.visible = options.visible !== false;
    mode.matches = options.matches !== false;
    w.matchMedia = () => mode;
    if (!options.noApi) {
        Object.defineProperty(w.navigator, "windowControlsOverlay", {
            value: overlay,
        });
    }
    if (options.legacyListener) {
        mode.addEventListener = undefined;
        mode.addListener = (fn) => (mode.addEventListenerFallback = fn);
    }
    if (options.native) w[options.native] = {};
    w.MutationObserver = function (callback) {
        const observation = { deliveries: 0, disconnected: 0 };
        const observer = new OriginalObserver((records) => {
            observation.deliveries++;
            callback(records);
        });
        observations.push(observation);
        return {
            disconnect() {
                observation.disconnected++;
                observer.disconnect();
            },
            observe(node, config) {
                observation.node = node;
                observation.config = config;
                observer.observe(node, config);
            },
        };
    };
    if (options.noObserver) w.MutationObserver = undefined;
    Object.defineProperty(doc, "fullscreenElement", {
        configurable: true,
        value: null,
        writable: true,
    });
    try {
        w.eval(code);
        doc.dispatchEvent(new w.Event("DOMContentLoaded"));
        await settle();
        await callback({ doc, mode, observations, overlay, w });
    } finally {
        w.close();
    }
}

async function test(name, run) {
    await run();
    passed++;
    console.log("PASS " + name);
}

async function main() {
    await test("optional browser helper parses as ES5", () => {
        acorn.parse(code, { ecmaVersion: 5 });
        acorn.parse(bootstrap, { ecmaVersion: 5 });
    });

    await test("browser bootstrap maps canonical routes and preserves existing script order", () => {
        const routes = {
            "/": "manifest.webmanifest",
            "/f/pc": "pc-plain.webmanifest",
            "/f/pc/": "pc.webmanifest",
            "/index.html": "index.webmanifest",
        };
        for (const route of Object.keys(routes)) {
            const dom = new JSDOM(html, {
                runScripts: "outside-only",
                url: "https://example.invalid" + route,
            });
            try {
                const w = dom.window;
                const doc = w.document;
                Object.defineProperty(w.navigator, "windowControlsOverlay", {
                    value: {},
                });
                const scripts = Array.from(doc.scripts);
                const before = scripts.map((script) => script.outerHTML);
                w.eval(bootstrap);
                assert.equal(
                    doc
                        .querySelector('link[rel="manifest"]')
                        .getAttribute("href"),
                    "/js/browser-app/" + routes[route]
                );
                assert.equal(
                    doc.querySelector(
                        'link[href="/js/browser-app/window-controls.css"]'
                    ).rel,
                    "stylesheet"
                );
                assert.equal(
                    doc.querySelectorAll(
                        'script[src="/js/browser-app/window-controls.js"]'
                    ).length,
                    1
                );
                assert.deepEqual(
                    scripts.map((script) => script.outerHTML),
                    before
                );
                const preserved = Array.from(doc.scripts).filter((script) =>
                    scripts.includes(script)
                );
                assert.deepEqual(preserved, scripts);
                assert.match(
                    doc.scripts[0].src,
                    /\/js\/runtime-polyfills\.js\?/
                );
            } finally {
                dom.window.close();
            }
        }
    });

    await test("bootstrap adds no resources to unsupported or noncanonical entries", () => {
        const profiles = [
            { noApi: true, path: "/" },
            { native: "__TAURI__", path: "/" },
            { native: "__TAURI_INTERNALS__", path: "/" },
            { native: "Capacitor", path: "/" },
            { native: "__ottNativeRuntime", path: "/" },
            { native: "Android", path: "/" },
            { path: "/?device=pc" },
            { path: "/index.html#profile" },
            { path: "/f/lg/webos/" },
            { path: "/f/samsung/tizen/" },
            { path: "/f/pc/index.html" },
            { url: "file:///player/index.html" },
            { url: "tauri://localhost/" },
        ];
        for (const profile of profiles) {
            const dom = new JSDOM(html, {
                runScripts: "outside-only",
                url: profile.url || "https://example.invalid" + profile.path,
            });
            try {
                const w = dom.window;
                if (!profile.noApi) {
                    Object.defineProperty(
                        w.navigator,
                        "windowControlsOverlay",
                        { value: {} }
                    );
                }
                if (profile.native) w[profile.native] = {};
                const before = w.document.head.innerHTML;
                w.eval(bootstrap);
                assert.equal(w.document.head.innerHTML, before);
                assert.equal(
                    w.document.querySelectorAll(
                        '[href^="/js/browser-app/"], [src^="/js/browser-app/"]'
                    ).length,
                    0
                );
            } finally {
                dom.window.close();
            }
        }
    });

    await test("unsupported browsers and native shells remain untouched", async () => {
        const profiles = [
            { noApi: true },
            { noObserver: true },
            { native: "__TAURI__" },
            { native: "__TAURI_INTERNALS__" },
            { native: "Capacitor" },
            { native: "Android" },
            { native: "__ottNativeRuntime" },
            { url: "file:///player/index.html" },
            { url: "tauri://localhost/" },
        ];
        for (const profile of profiles) {
            await fixture(profile, ({ doc, observations }) => {
                assert.equal(doc.documentElement.className, "existing");
                assert.equal(doc.getElementById("window-drag-region"), null);
                assert.equal(observations.length, 0);
            });
        }
    });

    await test("only visible overlay mode activates layout", async () => {
        for (const options of [{}, { visible: false }, { matches: false }]) {
            await fixture(options, ({ doc }) => {
                assert.equal(
                    doc.documentElement.classList.contains(
                        "ott-window-controls"
                    ),
                    options.visible !== false && options.matches !== false
                );
                const drag = doc.getElementById("window-drag-region");
                assert.equal(drag.parentNode, doc.documentElement);
                assert.equal(drag.getAttribute("aria-hidden"), "true");
                assert.equal(drag.hasAttribute("tabindex"), false);
                assert.equal(drag.textContent, "");
                assert.equal(doc.body.getAttribute("style"), null);
            });
        }
    });

    await test("titlebar toggles and fullscreen changes preserve other root classes", async () => {
        await fixture({}, ({ w, doc, overlay, mode }) => {
            overlay.visible = false;
            overlay.dispatchEvent(new w.Event("geometrychange"));
            assert.equal(doc.documentElement.className, "existing");
            overlay.visible = true;
            overlay.dispatchEvent(new w.Event("geometrychange"));
            assert.equal(
                doc.documentElement.className,
                "existing ott-window-controls"
            );
            doc.fullscreenElement = doc.documentElement;
            doc.dispatchEvent(new w.Event("fullscreenchange"));
            assert.equal(doc.documentElement.className, "existing");
            doc.fullscreenElement = null;
            doc.dispatchEvent(new w.Event("fullscreenchange"));
            assert.equal(
                doc.documentElement.className,
                "existing ott-window-controls"
            );
            mode.matches = false;
            mode.dispatchEvent(new w.Event("change"));
            assert.equal(doc.documentElement.className, "existing");
            mode.matches = true;
            w.dispatchEvent(new w.Event("resize"));
            assert.equal(
                doc.documentElement.className,
                "existing ott-window-controls"
            );
        });
    });

    await test("legacy media-query listeners can activate the overlay", async () => {
        await fixture(
            { legacyListener: true, matches: false },
            ({ doc, mode }) => {
                assert.equal(doc.documentElement.className, "existing");
                mode.matches = true;
                mode.addEventListenerFallback();
                assert.equal(
                    doc.documentElement.className,
                    "existing ott-window-controls"
                );
            }
        );
    });

    await test("preview follows real adapter geometry while full video and body stay unchanged", async () => {
        await fixture({}, async ({ doc }) => {
            doc.body.style.transform = "scale(0.9)";
            const box = doc.createElement("div");
            box.id = "vdiv";
            box.className = "player-box";
            box.style.cssText =
                "top:0;bottom:0;left:0;right:0;width:auto;height:auto";
            doc.body.insertBefore(box, doc.body.firstChild);
            await settle();
            assert.equal(box.className, "player-box");
            box.style.cssText =
                "top:62px;bottom:auto;left:10px;right:auto;width:512px;height:288px";
            const previewStyle = box.getAttribute("style");
            await settle();
            assert.equal(
                box.className,
                "player-box ott-window-controls-preview"
            );
            assert.equal(box.getAttribute("style"), previewStyle);
            box.style.cssText =
                "top:0;bottom:0;left:0;right:0;width:auto;height:auto";
            const fullStyle = box.getAttribute("style");
            await settle();
            assert.equal(box.className, "player-box");
            assert.equal(box.getAttribute("style"), fullStyle);
            assert.equal(doc.body.style.transform, "scale(0.9)");
        });
    });

    await test("video replacement disconnects old observer and ignores list churn", async () => {
        await fixture({}, async ({ doc, observations }) => {
            const oldBox = doc.createElement("div");
            oldBox.id = "vdiv";
            oldBox.style.cssText = "top:62px;bottom:auto";
            doc.body.appendChild(oldBox);
            await settle();
            const videoObserver = observations.find(
                (item) => item.node === oldBox
            );
            const bodyObserver = observations.find(
                (item) => item.node === doc.body
            );
            assert.deepEqual(JSON.parse(JSON.stringify(bodyObserver.config)), {
                childList: true,
            });
            assert.deepEqual(JSON.parse(JSON.stringify(videoObserver.config)), {
                attributeFilter: ["style"],
                attributes: true,
            });
            const before = bodyObserver.deliveries;
            doc.getElementById("list").innerHTML =
                '<div class="item">Channel</div>';
            doc.querySelector(".item").style.height = "30px";
            await settle();
            assert.equal(bodyObserver.deliveries, before);
            const newBox = doc.createElement("div");
            newBox.id = "vdiv";
            newBox.style.cssText = "top:31px;bottom:auto";
            doc.body.replaceChild(newBox, oldBox);
            await settle();
            assert.equal(videoObserver.node, newBox);
            assert.ok(videoObserver.disconnected >= 2);
            assert.equal(newBox.className, "ott-window-controls-preview");
            const priorDeliveries = videoObserver.deliveries;
            oldBox.style.cssText = "top:0;bottom:0";
            await settle();
            assert.equal(videoObserver.deliveries, priorDeliveries);
            newBox.style.cssText = "top:0;bottom:0";
            await settle();
            assert.equal(newBox.className, "");
        });
    });

    console.log(passed + " browser window controls tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
