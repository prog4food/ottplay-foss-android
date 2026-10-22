/* Execute both production detectors and the selected real remote adapter.
 * UAs/native API shapes simulate identification, not TV engines or decoding.
 * --bundle also checks the detector extracted from the emitted classic bundle.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const ts = require("typescript");
const { inlineScripts } = require("../scripts/html-scripts.cjs");

const root = path.resolve(__dirname, "..");
const fixtures = require("./fixtures/device-detection.json");
const scripts = inlineScripts(
    fs.readFileSync(path.join(root, "index.html"), "utf8")
);
assert(scripts.length > 0, "Exercise the real HTML boot scripts");
for (const script of scripts) acorn.parse(script, { ecmaVersion: 5 });

const sourceFile = "src/app/device.ts";
const compiled = ts
    .transpileModule(fs.readFileSync(path.join(root, sourceFile), "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.ES2015,
            target: ts.ScriptTarget.ES5,
        },
    })
    .outputText.replace(/^export /gm, "");
acorn.parse(compiled, { ecmaVersion: 5 });
const detectors = [{ code: compiled, name: sourceFile }];
if (process.argv.includes("--bundle")) {
    const bundle = fs.readFileSync(path.join(root, "dist/player.js"), "utf8");
    const ast = acorn.parse(bundle, { ecmaVersion: 5 });
    const declarations = ast.body.filter(
        (node) =>
            node.type === "FunctionDeclaration" &&
            node.id.name === "detectDevice"
    );
    assert.equal(
        declarations.length,
        1,
        "The classic bundle must expose one production detectDevice function"
    );
    const declaration = declarations[0];
    detectors.push({
        code:
            bundle.slice(declaration.start, declaration.end) +
            "\nott_device = detectDevice();",
        name: "dist/player.js detector",
    });
}

function collectAdapters(directory, prefix = "") {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory())
            result.push(
                ...collectAdapters(path.join(directory, entry.name), relative)
            );
        else if (entry.name === "device.js") result.push(prefix);
    }
    return result.sort();
}
const adapters = collectAdapters(path.join(root, "devices"));
assert(adapters.length >= 24, "Include every currently shipped adapter");
const adapterCode = new Map();
for (const adapter of adapters) {
    const code = fs.readFileSync(
        path.join(root, "devices", adapter, "device.js"),
        "utf8"
    );
    acorn.parse(code, { ecmaVersion: 5 });
    adapterCode.set(adapter, code);
}
assert.equal(
    new Set(fixtures.map((fixture) => fixture.name)).size,
    fixtures.length,
    "Fixture names must identify failures unambiguously"
);
for (const fixture of fixtures) {
    assert.equal(typeof fixture.pathname, "string");
    assert.equal(typeof fixture.userAgent, "string");
    assert.equal(typeof fixture.source, "string");
    assert(adapterCode.has(fixture.expectedDevice), fixture.name);
    assert(
        [undefined, "mag", "empty-gstb", "throwing-gstb"].includes(
            fixture.capability
        ),
        fixture.name
    );
}

const routeFixtures = [];
for (const adapter of adapters) {
    for (const suffix of ["", "/", "/index.html", "/nested/index.html"]) {
        for (const userAgent of [
            "UnknownEmbeddedBrowser/1.0",
            "Mozilla/5.0 (Web0S; Linux/SmartTV)",
        ]) {
            routeFixtures.push({
                capability: "mag",
                expectedDevice: adapter,
                name: "Explicit " + adapter + suffix + " with " + userAgent,
                pathname: "/f/" + adapter + suffix,
                userAgent,
            });
        }
    }
}

function runFixture(fixture, detector, legacy, nativeOverride) {
    const requests = [];
    let starts = 0;
    let bootDevice;
    let nativeCalls = 0;
    let nativeReads = 0;
    let context;
    let core;
    const elements = new Map();
    const document = {
        body: { className: "booting", style: {} },
        createElement(tagName) {
            return { style: {}, tagName };
        },
        getElementById(id) {
            if (!elements.has(id))
                elements.set(id, {
                    getAttribute() {
                        return null;
                    },
                    style: {},
                    textContent: "",
                });
            return elements.get(id);
        },
        getElementsByTagName() {
            return [this.head];
        },
    };
    document.head = {
        appendChild(tag) {
            if (tag.tagName !== "script") return;
            const requestPath = new URL(tag.src).pathname;
            requests.push(requestPath);
            if (requestPath === "/js/ottplay-core.js") {
                assert.equal(context.OttPlayCore, core);
            } else if (requestPath === "/dist/player.js") {
                bootDevice = context.ott_device;
                vm.runInContext(detector.code, context, {
                    filename: detector.name,
                });
                assert.deepEqual(
                    { boot: bootDevice, module: context.ott_device },
                    {
                        boot: fixture.expectedDevice,
                        module: fixture.expectedDevice,
                    },
                    "Both production detectors must select the expected device"
                );
                assert.equal(
                    context.ott_device,
                    bootDevice,
                    "The bundle detector must preserve the boot decision"
                );
            } else if (requestPath === "/js/video.min.js") {
                context.videojs = function () {};
            } else {
                const adapterMatch = requestPath.match(
                    /^\/devices\/(.+)\/device\.js$/
                );
                assert(
                    adapterMatch,
                    "Unexpected script request: " + requestPath
                );
                const adapter = adapterMatch[1];
                assert.equal(
                    adapter,
                    fixture.expectedDevice,
                    "Adapter request"
                );
                assert(adapterCode.has(adapter), "Requested adapter exists");
                vm.runInContext(adapterCode.get(adapter), context, {
                    filename: requestPath,
                });
            }
            if (typeof tag.onload === "function") tag.onload();
        },
    };
    document.body.appendChild = document.head.appendChild;
    context = vm.createContext({
        // Runtime loading is covered by test_legacy_boot; this fixture isolates
        // detection and device adapters even without modern language APIs.
        __ottMediaRuntimeVersion: "1234567890abcdef",
        __ottRuntimePolyfillsReady: true,
        clearInterval() {},
        console,
        document,
        Hls() {},
        jQuery: {},
        localStorage: {
            getItem() {
                return "existing-test-device";
            },
            setItem() {},
        },
        location: {
            host: "device-matrix.test",
            origin: "http://device-matrix.test",
            pathname: fixture.pathname,
            protocol: "http:",
        },
        navigator: { userAgent: fixture.userAgent },
        setInterval() {
            return 1;
        },
        setTimeout() {
            return 1;
        },
        shaka: { Player() {} },
        startPlayer() {
            starts++;
        },
        stb: { getMacAddress: () => "fixture-device" },
        stbInit() {},
        version: "fixture",
    });
    context.window = context;
    context.self = context;
    const noNativeCalls = () => {
        nativeCalls++;
        throw new Error("Detection must not call native device APIs");
    };
    if (fixture.capability === "mag") {
        context.gSTB = {
            GetDeviceMacAddress: noNativeCalls,
            GetDeviceModel: noNativeCalls,
        };
    } else if (fixture.capability === "empty-gstb") context.gSTB = {};
    else if (fixture.capability === "throwing-gstb") {
        Object.defineProperty(context, "gSTB", {
            get() {
                nativeReads++;
                throw new Error("Native bridge unavailable");
            },
        });
    }
    if (nativeOverride) nativeOverride(context, noNativeCalls);
    // Initialize the real core before removing APIs for this detector-only
    // matrix. Full script loading with shipped polyfills is tested separately.
    core = require("./helpers/shared-core-runtime.cjs")(context);
    if (legacy) {
        vm.runInContext(
            "Array.from = undefined; Promise = undefined; Uint8Array = undefined;" +
                "Map = undefined; Set = undefined; Symbol = undefined;" +
                "Object.assign = undefined; String.prototype.includes = undefined;",
            context
        );
    }
    for (const script of scripts)
        vm.runInContext(script, context, { filename: "index.html boot" });
    assert.equal(starts, 1, "Boot reaches startPlayer once");
    assert.deepEqual(requests, [
        "/js/ottplay-core.js",
        ...(fixture.expectedDevice === "pc2" ? ["/js/video.min.js"] : []),
        "/dist/player.js",
        "/devices/" + fixture.expectedDevice + "/device.js",
    ]);
    for (const key of ["UP", "DOWN", "LEFT", "RIGHT", "ENTER", "RETURN"]) {
        assert.equal(typeof context.keys[key], "number", "Loaded key " + key);
        assert(context.keys[key] > 0, "Usable remote key " + key);
    }
    if (fixture.expectedDevice === "lg/netcast")
        assert.equal(context.keys.RETURN, 8, "NetCast Back key");
    if (fixture.expectedDevice === "lg/webos")
        assert.equal(context.keys.RETURN, 461, "webOS Back key");
    if (fixture.expectedDevice === "mag")
        assert.equal(context.keys.PLAY, 68, "MAG Play key, distinct from PC");
    assert.equal(nativeCalls, 0, "Detection has no native API side effects");
    if (fixture.pathname.startsWith("/f/"))
        assert.equal(
            nativeReads,
            0,
            "Explicit routes do not access native APIs"
        );
}

const failures = [];
let checks = 0;
function check(fixture, detector, legacy, nativeOverride) {
    checks++;
    try {
        runFixture(fixture, detector, legacy, nativeOverride);
    } catch (error) {
        failures.push(
            detector.name +
                " / " +
                (legacy ? "legacy APIs" : "modern APIs") +
                " / " +
                fixture.name +
                ": " +
                error.message
        );
    }
}

for (const detector of detectors) {
    for (const legacy of [false, true]) {
        for (const fixture of [...fixtures, ...routeFixtures])
            check(fixture, detector, legacy);
        // Each supported API spelling must suffice independently. Merely named,
        // non-callable methods and throwing method getters must not identify MAG.
        for (const method of [
            "GetDeviceModel",
            "GetDeviceMacAddress",
            "GetMACAddress",
        ]) {
            check(
                {
                    expectedDevice: "mag",
                    name: "MAG capability through only " + method,
                    pathname: "/",
                    userAgent: "UnknownEmbeddedBrowser/1.0",
                },
                detector,
                legacy,
                (context, noNativeCalls) => {
                    context.gSTB = { [method]: noNativeCalls };
                }
            );
        }
        for (const broken of ["non-callable", "throwing-property"]) {
            check(
                {
                    expectedDevice: "pc",
                    name: "MAG capability rejects " + broken,
                    pathname: "/",
                    userAgent: "UnknownEmbeddedBrowser/1.0",
                },
                detector,
                legacy,
                (context) => {
                    context.gSTB = {
                        GetDeviceMacAddress: "fixture-device",
                        GetDeviceModel: "MAG250",
                        GetMACAddress: "fixture-device",
                    };
                    if (broken === "throwing-property")
                        Object.defineProperty(context.gSTB, "GetDeviceModel", {
                            get() {
                                throw new Error("Native bridge unavailable");
                            },
                        });
                }
            );
        }
    }
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log(
    "PASS: " +
        checks +
        " boot/detector/adapter checks; " +
        fixtures.length +
        " documented or labeled synthetic fixtures, all " +
        adapters.length +
        " adapter routes, legacy APIs, ES5 syntax and native API failure guards"
);
