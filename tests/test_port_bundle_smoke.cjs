const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const { webcrypto } = require("node:crypto");
const { assertQrSvg } = require("./helpers/qr-svg.cjs");
const { assertLzWire } = require("./test_lzstring.cjs");
const assertMenuRuntime = require("./helpers/menu-runtime.cjs");
const {
    checkBundleIdentifiers,
} = require("../scripts/check-bundle-identifiers.cjs");
const { CLASSIC_PROVIDER_BUNDLES } = require("../scripts/classic-bundle.cjs");

const publicFixture = `
    function startPlayer() {} var popupActions = [];
    function noProvParam() {} function optionsList() {}
    function makeRedefinable(name, get, set) {
        Object.defineProperty(window, name, { get: get, set: set });
    }
    makeRedefinable("listKeyHandler", function () {}, function (value) {});
    window.chanels = [];
`;
checkBundleIdentifiers(publicFixture);
checkBundleIdentifiers(
    publicFixture.replace("window.chanels = []", "var chanels = []")
);
assert.throws(
    () =>
        checkBundleIdentifiers(
            publicFixture.replace(
                "window.chanels = []",
                "(function () { var chanels = []; })()"
            )
        ),
    /chanels/,
    "A function-local declaration must not satisfy browser global publication"
);
assert.throws(
    () => checkBundleIdentifiers(JSON.stringify(publicFixture) + ";"),
    /Missing classic global/,
    "Identifier strings alone do not establish the plugin ABI"
);
assert.throws(
    () => checkBundleIdentifiers("(function () {" + publicFixture + "})();"),
    /Missing classic global/,
    "Locally scoped names cannot satisfy the bare-global ABI"
);
assert.throws(
    () =>
        checkBundleIdentifiers(
            publicFixture.replace("window.chanels = []", "other.chanels = []")
        ),
    /chanels/,
    "An unrelated object property cannot satisfy a window publication"
);

// No network requests or media decoding run. Selected controller timers are
// driven explicitly through fake host ports after loading the complete artifact.
const bundlePath = path.resolve(
    process.argv[2] || path.join(__dirname, "../dist/player.js")
);
const bundle = fs.readFileSync(bundlePath, "utf8");
const playDistribution = process.argv.includes("--play");
checkBundleIdentifiers(bundle);
const globalNames = new Set();
function collectGlobals(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration") {
        globalNames.add(node.id.name);
        return;
    }
    if (
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression"
    )
        return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier")
        globalNames.add(node.id.name);
    for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) child.forEach(collectGlobals);
        else if (child && typeof child === "object") collectGlobals(child);
    }
}
collectGlobals(acorn.parse(bundle, { ecmaVersion: 5 }));
for (const name of [
    "installTextEncoder",
    "installPerformanceNow",
    "applyWebRuntimePolyfills",
])
    assert(
        !globalNames.has(name),
        "The classic bundle must reuse the shared bootstrap: " + name
    );
const fixtureTimers = new WeakMap();
const optionalProviderApis = {
    catalog: ["__ottCatalogDrivers"],
    edem: ["__ottEdemDriver"],
    m3u: ["__ottM3uDriver", "__ottM3uSettings"],
    playlist: ["__ottPlaylistDrivers"],
    plex: ["__ottPlex", "__ottPlexAuth", "__ottPlexDriver"],
    stalker: ["__ottStalkerDriver"],
    vportal: ["__ottVPortalDriver"],
    xtream: ["__ottXtreamMedia"],
};
assert.deepEqual(
    Object.keys(CLASSIC_PROVIDER_BUNDLES).sort(),
    Object.keys(optionalProviderApis).sort(),
    "Every emitted provider family has an artifact ABI assertion"
);

function providerKinds() {
    return playDistribution
        ? ["m3u", "plex", "stalker", "vportal"]
        : Object.keys(CLASSIC_PROVIDER_BUNDLES);
}

function assertProvidersUnloaded(w, profile) {
    for (const apis of Object.values(optionalProviderApis))
        for (const api of apis)
            assert.equal(
                w[api],
                undefined,
                profile + ": main bundle defers provider implementation " + api
            );
}

function loadProviderBundle(w, kind) {
    assert(providerKinds().includes(kind), "Unexpected provider asset " + kind);
    const file = path.join(
        path.dirname(bundlePath),
        "provider-" + kind + ".js"
    );
    const source = fs.readFileSync(file, "utf8");
    acorn.parse(source, { ecmaVersion: 5 });
    vm.runInContext(source, w, { filename: file, timeout: 5000 });
}

function assertProviderFactories(w, profile) {
    for (const kind of providerKinds())
        for (const api of optionalProviderApis[kind])
            for (const method of w.__ottProviderAssets.groups[kind]
                .find((entry) => entry[0] === api)
                .slice(1))
                assert.equal(
                    typeof w[api]?.[method],
                    "function",
                    profile +
                        ": emitted provider asset initializes " +
                        api +
                        "." +
                        method
                );
}

function assertProviderMenuIds(w, provider) {
    // These IDs are already stored in sHideMenus on existing installations.
    // Exercise real provider closures from the emitted assets, not just the
    // optimizer's synthetic callback fixtures.
    const expected = {
        "1ott": ["settingsMenu"],
        antifriz: ["editKey", "editMode", ""],
        "bestlist/stalker": ["editSettings"],
        edem: ["settingsMenu"],
        itv: ["editKey", "changeMode", "subscription", ""],
        "kb-team": ["editSlot", "loadSlot", "info"],
        m3u: ["showSlots"],
        only4: ["settingsMenu"],
        ottclub: ["editAddress", "editKey", ""],
        "shara-tv": ["editUser", "editPassword", ""],
        shura: ["editAddress", "editKey", "changeMode", ""],
        tvteam: ["editUrl"],
    }[provider];
    assert(expected, "Missing persisted menu fixture: " + provider);
    const records = w.__ottMenuRegistry.importClassic(w);
    assert.deepEqual(
        Array.from(records, (record) => record.legacyId),
        ["noProvParam", ...expected, "optionsList"],
        provider + ": minification preserves persisted menu identities"
    );
    const previous = w.sHideMenus;
    try {
        for (const record of records) {
            if (!record.legacyId) continue;
            w.sHideMenus = [];
            assert(
                w.__ottMenuRegistry
                    .open(w, 0)
                    .rows.some((row) => row.action === record.action),
                provider + ": menu action is initially visible"
            );
            w.sHideMenus = [record.legacyId];
            assert(
                !w.__ottMenuRegistry
                    .open(w, 0)
                    .rows.some((row) => row.action === record.action),
                provider + ": saved preference still hides " + record.legacyId
            );
        }
    } finally {
        w.sHideMenus = previous;
    }
}

function fixture(profile) {
    const elements = new Map();
    const listeners = [];
    let timerId = 0;
    const timers = new Map();
    function element(name) {
        if (elements.has(name)) return elements.get(name);
        const e = {
            addEventListener(...args) {
                listeners.push([name, ...args]);
            },
            appendChild(child) {
                this.children.push(child);
                child.parentNode = this;
                return child;
            },
            attributes: {},
            blur() {},
            childNodes: [],
            children: [],
            classList: {
                add() {},
                contains() {
                    return false;
                },
                remove() {},
                toggle() {},
            },
            click() {},
            clientHeight: 720,
            clientWidth: 1280,
            dispatchEvent() {
                return true;
            },
            focus() {},
            getAttribute(key) {
                return this.attributes[key] || null;
            },
            getBoundingClientRect() {
                return {
                    bottom: 720,
                    height: 720,
                    left: 0,
                    right: 1280,
                    top: 0,
                    width: 1280,
                };
            },
            getElementsByTagName() {
                return [];
            },
            id: name,
            innerHTML: "",
            insertBefore(child) {
                return this.appendChild(child);
            },
            nodeType: 1,
            offsetHeight: 720,
            offsetWidth: 1280,
            querySelectorAll() {
                return [];
            },
            removeAttribute(key) {
                delete this.attributes[key];
            },
            removeChild(child) {
                this.children = this.children.filter((x) => x !== child);
                return child;
            },
            removeEventListener() {},
            scrollTop: 0,
            setAttribute(key, value) {
                this.attributes[key] = String(value);
            },
            style: {},
            tagName: name.toUpperCase(),
            textContent: "",
            value: "",
        };
        elements.set(name, e);
        return e;
    }
    const document = {
        activeElement: null,
        addEventListener(...args) {
            listeners.push(["document", ...args]);
        },
        body: element("body"),
        cookie: "",
        createElement: (tag) => element(tag),
        documentElement: element("html"),
        getElementById: (id) => element(id),
        getElementsByTagName: (tag) =>
            tag === "head" ? [element("head")] : [],
        head: element("head"),
        querySelector: () => null,
        querySelectorAll: () => [],
        readyState: "complete",
        removeEventListener() {},
        title: "",
    };
    function jquery(selector) {
        const el =
            typeof selector === "string"
                ? element(selector.replace(/^#/, ""))
                : selector || element("body");
        const chain = {
            0: el,
            css() {
                return arguments.length > 1 || typeof arguments[0] === "object"
                    ? this
                    : "";
            },
            each(callback) {
                callback.call(el, 0, el);
                return this;
            },
            get(i) {
                return i === undefined ? [el] : el;
            },
            height: () => 720,
            html(value) {
                if (!arguments.length) return el.innerHTML;
                el.innerHTML = value;
                return this;
            },
            is: () => false,
            length: 1,
            offset: () => ({ left: 0, top: 0 }),
            position: () => ({ left: 0, top: 0 }),
            text(value) {
                return arguments.length ? this : "";
            },
            val(value) {
                return arguments.length ? this : "";
            },
            width: () => 1280,
        };
        for (const name of [
            "on",
            "off",
            "bind",
            "unbind",
            "click",
            "ready",
            "show",
            "hide",
            "toggle",
            "append",
            "prepend",
            "appendTo",
            "remove",
            "empty",
            "attr",
            "removeAttr",
            "addClass",
            "removeClass",
            "toggleClass",
            "find",
            "children",
            "parent",
            "eq",
            "first",
            "last",
            "focus",
            "blur",
            "trigger",
            "scrollTop",
            "animate",
            "stop",
            "fadeIn",
            "fadeOut",
            "prop",
            "data",
        ]) {
            chain[name] = function () {
                return this;
            };
        }
        return chain;
    }
    jquery.extend = Object.assign;
    jquery.isArray = Array.isArray;
    jquery.parseJSON = JSON.parse;
    jquery.each = (object, fn) =>
        Object.keys(object).forEach((key) => fn(key, object[key]));
    jquery.ajax = () => ({ abort() {} });
    jquery.get = jquery.post = jquery.getJSON = jquery.ajax;
    const storage = {};
    const w = {
        __av: "smoke",
        __cv: "smoke",
        $: jquery,
        addEventListener(...args) {
            listeners.push(["window", ...args]);
        },
        alert() {},
        clearInterval(id) {
            timers.delete(id);
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        close() {},
        confirm: () => false,
        console: { debug() {}, error() {}, info() {}, log() {}, warn() {} },
        // Exercise the real ES5 crypto path with a platform CSPRNG; absence
        // and failure are covered by the dedicated PIN rejection tests.
        crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
        deviceUUID: "smoke-device",
        document,
        focus() {},
        getComputedStyle: () => ({
            display: "block",
            getPropertyValue: () => "",
        }),
        host_ott: "http://localhost",
        innerHeight: 720,
        innerWidth: 1280,
        jQuery: jquery,
        localStorage: {
            clear: () => {
                for (const key of Object.keys(storage)) delete storage[key];
            },
            getItem: (key) => storage[key] ?? null,
            removeItem: (key) => {
                delete storage[key];
            },
            setItem: (key, value) => {
                storage[key] = String(value);
            },
        },
        location: {
            hash: "",
            host: "localhost",
            hostname: "localhost",
            href: "http://localhost/",
            origin: "http://localhost",
            pathname: "/",
            protocol: "http:",
            search: "",
        },
        navigator: {
            language: "en",
            onLine: true,
            platform: "STB",
            userAgent: "Legacy STB smoke",
        },
        open() {},
        ott_device: "pc",
        removeEventListener() {},
        screen: {
            availHeight: 720,
            availWidth: 1280,
            height: 720,
            width: 1280,
        },
        setInterval(fn, delay) {
            timers.set(++timerId, { delay, fn });
            return timerId;
        },
        setTimeout(fn, delay) {
            timers.set(++timerId, { delay, fn });
            return timerId;
        },
    };
    if (profile === "capacitor-fallback") w.Capacitor = { Plugins: {} };
    if (profile === "capacitor-native") {
        w.Capacitor = {
            Plugins: {
                DashExoPlayer: {
                    isDashSupported: () => Promise.resolve({ ok: true }),
                },
                MobileNativeMedia: {
                    getVolume: () => Promise.resolve({ ok: true, volume: 37 }),
                },
            },
        };
    }
    w.window = w;
    w.self = w;
    w.globalThis = w;
    // Browsers create nonconfigurable Window properties for global var/function
    // declarations. Node's contextified sandbox can otherwise allow accessors to
    // replace an uninitialized declaration, producing a VM-only recursion.
    for (const name of globalNames) {
        Object.defineProperty(w, name, {
            configurable: false,
            enumerable: true,
            value: w[name],
            writable: true,
        });
    }
    vm.createContext(w);
    if (profile === "legacy") {
        vm.runInContext(
            `
            Promise = undefined; Map = undefined; Set = undefined; WeakMap = undefined;
            WeakSet = undefined; Symbol = undefined; Reflect = undefined; Proxy = undefined;
            Number.isFinite = undefined; Number.isNaN = undefined; Number.isInteger = undefined;
            Number.parseInt = undefined; Number.parseFloat = undefined; Object.assign = undefined;
            delete String.prototype.includes; delete String.prototype.startsWith;
            delete String.prototype.endsWith; delete String.prototype.repeat;
            delete Array.prototype.findIndex; delete Array.prototype.find;
            delete Array.prototype.includes; Array.from = undefined;
            Object.entries = undefined; Object.values = undefined;
            TextEncoder = undefined; performance = undefined;
        `,
            w
        );
    }
    vm.runInContext(
        fs.readFileSync(
            path.join(__dirname, "../js/runtime-polyfills.js"),
            "utf8"
        ),
        w
    );
    require("./helpers/shared-core-runtime.cjs")(w, { vendorOnly: true });
    for (const api of [
        "__ottCloudSettingsCodec",
        "__ottAccessSession",
        "__ottParental",
        "__ottScreenController",
        "__ottScreens",
        "__ottInputRouter",
        "__ottClassicScreenPort",
        "__ottMenuRegistry",
        "__ottMediaBackend",
        "__ottOsMediaSession",
        "__ottNativePip",
        "__ottDeviceAdapter",
        "__ottPlaybackSession",
        "__ottPlaybackJournal",
        "__ottArchiveSession",
        "__ottClassicArchive",
        "__ottProviderDrivers",
        "__ottProviderDriverProfiles",
        "__ottProviderAssets",
        "__ottStalkerDriver",
        "__ottCatalogDrivers",
        "__ottCatalogXml",
        "__ottMediaCatalog",
        "__ottPlaylistDrivers",
        "__ottEdemDriver",
        "__ottM3uDriver",
        "__ottM3uSettings",
        "__ottClassicPlayback",
        "__ottProviderRuntime",
    ])
        assert.equal(
            w[api],
            undefined,
            "fixture must not inject private source API " + api
        );
    fixtureTimers.set(w, timers);
    return w;
}

function assertPrivateRuntime(w, profile) {
    for (const [api, method] of [
        ["__ottCloudSettingsCodec", "read"],
        ["__ottCloudSettingsCodec", "write"],
        ["__ottAccessSession", "create"],
        ["__ottParental", "request"],
        ["__ottScreenController", "create"],
        ["__ottScreens", "open"],
        ["__ottInputRouter", "create"],
        ["__ottClassicScreenPort", "commitList"],
        ["__ottMenuRegistry", "open"],
        ["__ottMediaBackend", "create"],
        ["__ottOsMediaSession", "create"],
        ["__ottNativePip", "create"],
        ["__ottDeviceAdapter", "create"],
        ["__ottPlaybackSession", "create"],
        ["__ottPlaybackJournal", "create"],
        ["__ottArchiveSession", "create"],
        ["__ottClassicArchive", "open"],
        ["__ottClassicArchive", "pauseLive"],
        ["__ottClassicArchive", "rewind"],
        ["__ottClassicArchive", "update"],
        ["__ottProviderDrivers", "createRegistry"],
        ["__ottProviderDrivers", "mount"],
        ["__ottProviderAssets", "create"],
        ["__ottCatalogXml", "decode"],
        ["__ottMediaCatalog", "create"],
        ["__ottClassicPlayback", "select"],
        ["__ottClassicPlayback", "shift"],
        ["__ottClassicPlayback", "cancel"],
        ["__ottProviderRuntime", "createRegistry"],
        ["__ottProviderRuntime", "createClassicAdapter"],
    ]) {
        assert.equal(
            typeof w[api]?.[method],
            "function",
            profile + ": bundle initializes " + api + "." + method
        );
    }
    assert.equal(typeof w.__ottProviderAssets.classic.ensure, "function");
    assert.equal(typeof w.__ottProviderRuntime.classic.replace, "function");
    for (const method of ["bind", "loadScript"])
        assert.equal(
            typeof w.__ottProviderRuntime.classic[method],
            playDistribution ? "undefined" : "function",
            profile + ": external script capability follows the distribution"
        );
    if (playDistribution) {
        assert.equal(w.__ottCatalogDrivers, undefined);
        assert.equal(w.__ottPlaylistDrivers, undefined);
        assert.equal(w.__ottEdemDriver, undefined);
        assert.deepEqual(
            Array.from(w.__ottProviderDrivers.registry.ids()).sort(),
            ["demo", "m3u", "offline", "plex", "stalker", "vportal", "xtream"]
        );
    } else {
        assert.equal(w.__ottProviderDrivers.registry.ids().length, 51);
    }
    assert(Array.isArray(w.__ottProviderDriverProfiles));
    assert.deepEqual(
        Array.from(w.__ottProviderDrivers.registry.ids()),
        Array.from(w.__ottProviderDriverProfiles, (profile) => profile.id)
    );
    const selectableProviders = Array.from(w.providerIds).filter(Boolean);
    assert.equal(
        new Set(selectableProviders).size,
        selectableProviders.length,
        profile + ": selectable provider IDs are unique"
    );
    assert.deepEqual(
        selectableProviders.slice().sort(),
        Array.from(w.__ottProviderDrivers.registry.ids()).sort(),
        profile + ": every selectable provider has exactly one managed driver"
    );
    for (const name of [
        "startCloudSettings",
        "cloudSettingsIntent",
        "cancelCloudSettings",
        "readCloudSettings",
        "writeCloudSettings",
        "cloudCodecEncode",
        "cloudCodecDecode",
        "createAccessSession",
        "createClassicAccess",
        "createPinEntry",
        "createScreenController",
        "createInputRouter",
        "createClassicScreenPort",
        "createScreenMenuRegistry",
        "screenMenuDefinitions",
        "createMediaBackend",
        "createDeviceAdapter",
        "createOsMediaSession",
        "createNativePipPort",
        "createPlaybackJournal",
        "createArchiveController",
        "classicArchiveController",
        "classicArchiveRuntime",
        "createDriverRegistry",
        "providerDriverRegistry",
        "createDemoDriver",
        "createXtreamDriver",
        "createNamedPlaylistDriver",
        "mountNamedProviderSettings",
        "createStalkerProviderDriver",
        "mountStalkerProviderSettings",
        "createCatalogProviderDriver",
        "mountCatalogProviderSettings",
        "reportCatalogProviderLoad",
        "decodeProviderCatalogXml",
        "licensedXmlToJson",
        "createOwnedMediaCatalog",
        "createOwnedPlaylistDriver",
        "mountOwnedPlaylistDriver",
        "reportOwnedPlaylistLoad",
        "operatorLoadPlaylist",
        "operatorLoadVod",
        "operatorGenericSession",
        "operatorXmlToJson",
        "createEdemProviderDriver",
        "createM3uProviderDriver",
        "mountM3uProviderSettings",
        "namedCredentialMessage",
        "createOperatorDriver",
        "providerDriverProfiles",
        "createDriverTransport",
        "mountProviderDriver",
        "createPlaybackSessionController",
        "classicPlaybackController",
        "classicPlaybackRuntime",
        "classicPlaybackSelect",
        "createProviderRegistry",
        "createClassicProviderAdapter",
    ]) {
        assert.equal(
            vm.runInContext("typeof " + name, w),
            "undefined",
            profile + ": private implementation leaked: " + name
        );
    }
    // Also catch a renamed top-level leak after optimizer-local mangling.
    for (const implementation of [
        w.__ottCloudSettingsCodec.read,
        w.__ottCloudSettingsCodec.write,
        w.__ottScreenController.create,
        w.__ottInputRouter.create,
        w.__ottPlaybackSession.create,
        w.__ottPlaybackJournal.create,
        w.__ottArchiveSession.create,
        w.__ottClassicArchive.open,
        w.__ottProviderDrivers.createRegistry,
        w.__ottProviderDrivers.mount,
        w.__ottClassicPlayback.select,
        w.__ottProviderRuntime.createRegistry,
        w.__ottProviderRuntime.createClassicAdapter,
    ]) {
        assert(
            !Object.keys(w).some((key) => w[key] === implementation),
            profile + ": private implementation exposed as bare global"
        );
    }
}

function exerciseCloudRuntime(profile) {
    function cloudFixture() {
        const w = fixture(profile);
        vm.runInContext(bundle, w, { filename: bundlePath });
        const stored = new Map([
                ["ordinary", "before"],
                ["obsolete", "remove"],
            ]),
            requests = [],
            writes = [],
            timers = fixtureTimers.get(w);
        timers.clear();
        let restarted = 0,
            reject = null;
        Object.assign(w, {
            host_ott: "cloud.invalid",
            host_ott_proto: "https://",
            p_pref: "cloud-artifact",
            restart: () => restarted++,
            stbClearAllItems() {
                throw Error("Restore must use checked per-key writes");
            },
            stbDelItem(key) {
                writes.push([key, null]);
                if (key !== reject) stored.delete(key);
            },
            stbGetAllItems: () => Object.fromEntries(stored),
            stbGetItem: (key) => stored.get(key) ?? null,
            stbSetItem(key, value) {
                writes.push([key, value]);
                if (key !== reject) stored.set(key, value);
            },
        });
        w.jQuery.ajax = (options) => {
            const request = {
                abort() {
                    this.aborts++;
                    options.error({ responseText: "aborted" });
                },
                aborts: 0,
                options,
            };
            requests.push(request);
            return request;
        };
        function tick(delay) {
            const job = [...timers].find(([, value]) => value.delay === delay);
            assert(job, profile + ": cloud timer " + delay);
            timers.delete(job[0]);
            job[1].fn();
        }
        return {
            html: () => w.document.getElementById("listAbout").innerHTML,
            load() {
                w.cloudLoadSettings();
                assert.equal(requests.at(-1).options.data.c, "get_code");
                requests.at(-1).options.success({ code: "artifact-code" });
                tick(10000);
                assert.equal(requests.at(-1).options.data.c, "get");
                assert.equal(requests.at(-1).options.data.d, "artifact-code");
                return requests.at(-1);
            },
            reject(key) {
                reject = key;
            },
            requests,
            restarts: () => restarted,
            stored,
            tick,
            timers,
            w,
            writes,
        };
    }
    const f = cloudFixture(),
        w = f.w;
    assert.equal(typeof w.cloudSendSettings, "function");
    assert.equal(typeof w.cloudLoadSettings, "function");
    const text =
        '  "Quoted" <&> </entry> Программа 🎬\r\n' + "repeat ".repeat(100);
    const compressed = "\x01LZ\x01" + w.compress(text);
    const expected = {
        compressed,
        control: "\0\x01\t\r\n\ud800\udfff\ufffe\uffff",
        empty: "",
        'key "<&\x01': "value '&<>\r\n",
        ordinary: text,
    };
    f.stored.clear();
    for (const [key, value] of Object.entries(expected))
        f.stored.set(key, value);
    f.stored.set("commandServerToken", "must-not-export");
    w.cloudSendSettings();
    const sent = f.requests[0];
    assert.equal(sent.options.url, "https://cloud.invalid/swop/a.php");
    assert.equal(sent.options.data.c, "send");
    const xml = sent.options.data.d;
    assert.equal(xml.includes("must-not-export"), false);
    assert.deepEqual(
        Object.assign({}, w.__ottCloudSettingsCodec.read(xml)),
        expected
    );
    sent.options.success({ code: '<b onclick="bad">&' });
    assert.equal(f.html().includes('<b onclick="bad">'), false);
    assert(
        f.html().includes("&lt;b"),
        "cloud code is escaped in actual renderer"
    );
    f.stored.clear();
    f.stored.set("ordinary", "before");
    f.stored.set("obsolete", "remove");
    f.stored.set("commandServerToken", "old-authority");
    const incoming = f.load();
    incoming.options.success({ data: xml, status: "success" });
    incoming.options.success({ data: xml, status: "success" });
    assert.deepEqual(Object.fromEntries(f.stored), expected);
    assert.equal(w.decompress(f.stored.get("compressed").slice(4)), text);
    assert.equal(f.restarts(), 1, "actual restore completes only once");
    assert(
        f.writes.some(([key, value]) => key === "obsolete" && value === null)
    );
    assert(
        f.writes.some(
            ([key, value]) => key === "commandServerToken" && value === null
        )
    );
    w.aboutKeyHandler(w.keys.RETURN);

    for (const rejected of ["ordinary", "obsolete"]) {
        const f = cloudFixture(),
            before = Object.fromEntries(f.stored);
        f.reject(rejected);
        const pending = f.load();
        pending.options.success({
            data: f.w.__ottCloudSettingsCodec.write({
                added: "new",
                ordinary: "after",
            }),
            status: "success",
        });
        assert.deepEqual(
            Object.fromEntries(f.stored),
            before,
            "actual bundle rolls back rejected " + rejected
        );
        assert.equal(f.restarts(), 0);
        assert(f.html().includes("could not be saved"));
        f.w.aboutKeyHandler(f.w.keys.RETURN);
    }
    for (const stage of ["get_code", "poll"])
        for (const cause of ["back", "source", "screen"]) {
            const f = cloudFixture(),
                before = Object.fromEntries(f.stored);
            if (stage === "poll") f.load();
            else f.w.cloudLoadSettings();
            const pending = f.requests.at(-1);
            if (cause === "back") f.w.aboutKeyHandler(f.w.keys.RETURN);
            if (cause === "source") f.w.p_pref = "cloud-replacement";
            if (cause === "screen") f.w.__ottClassicScreenPort.invalidate();
            const shown = f.html(),
                requestCount = f.requests.length;
            pending.options.success(
                stage === "get_code"
                    ? { code: "late" }
                    : {
                          data: f.w.__ottCloudSettingsCodec.write({
                              injected: "late",
                          }),
                          status: "success",
                      }
            );
            pending.options.error({ responseText: "late error" });
            assert.equal(
                f.html(),
                shown,
                stage + ": retired " + cause + " view unchanged"
            );
            assert.deepEqual(Object.fromEntries(f.stored), before);
            assert.equal(f.writes.length, 0);
            assert.equal(f.restarts(), 0);
            assert.equal(f.requests.length, requestCount);
            assert.equal(f.timers.size, 0);
            assert.equal(pending.aborts, 1);
        }
    const retired = cloudFixture();
    retired.w.cloudLoadSettings();
    retired.requests[0].options.success({ code: "old" });
    const latePoll = [...retired.timers.values()].find(
        (job) => job.delay === 10000
    ).fn;
    retired.w.aboutKeyHandler(retired.w.keys.RETURN);
    retired.w.cloudSendSettings();
    latePoll();
    assert.equal(
        retired.requests.length,
        2,
        "escaped timer cannot revive a retired poll"
    );
    retired.w.aboutKeyHandler(retired.w.keys.RETURN);
    console.log(
        "OK: actual " +
            profile +
            " bundle cloud XML/raw restore, rollback and retired requests"
    );
}

async function exerciseAccessRuntime(profile) {
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath });
    w.p_pref = "access-a";
    const settlePin = require("./helpers/protected-pin-fixture.cjs")(
        w,
        "2468",
        () => {
            for (const [id, job] of [...fixtureTimers.get(w)]) {
                if (job.delay !== 0) continue;
                fixtureTimers.get(w).delete(id);
                job.fn();
            }
        },
        profile !== "legacy"
    );
    const protectedPIN = w.parentPIN;
    w.sPSchannels = 1;
    let accepted = 0;
    w.setParentAccess(true, () => accepted++);
    const oldExpiry = [...fixtureTimers.get(w).values()].find(
        (job) => job.delay === 3600000
    );
    assert(oldExpiry, "actual grant schedules hourly expiry");
    w.setParentAccess(true, () => accepted++);
    oldExpiry.fn();
    assert.equal(
        w.parentAccess,
        true,
        "old artifact timer cannot revoke renewed grant"
    );
    assert.equal(accepted, 2);
    w.parentPIN = "9999";
    w.parentPIN = protectedPIN;
    assert.equal(
        w.parentAccess,
        false,
        "actual SettingsStore epochs reject a PIN ABA grant"
    );
    w.enterPinAndSetAccess(() => accepted++);
    const entry = w.dialogBoxKeyHandler;
    for (const digit of "2468") entry(w.keys["N" + digit]);
    assert.equal(accepted, 2, "hash verification must settle asynchronously");
    await settlePin();
    assert.equal(accepted, 3);
    assert.equal(w.parentAccess, true);
    w.parentAccess = false;
    w.enterPinAndSetAccess(() => accepted++);
    const changedPin = w.dialogBoxKeyHandler;
    w.parentPIN = "9999";
    w.parentPIN = protectedPIN;
    for (const digit of "2468") changedPin(w.keys["N" + digit]);
    assert.equal(
        accepted,
        3,
        "actual SettingsStore epochs reject a PIN ABA challenge"
    );
    w.enterPinAndSetAccess(() => accepted++);
    const retired = w.dialogBoxKeyHandler;
    w.p_pref = "access-b";
    for (const digit of "2468") retired(w.keys["N" + digit]);
    assert.equal(accepted, 3, "retired source cannot receive the PIN replay");
    assert.equal(w.parentAccess, false);
    console.log(
        "OK: actual " +
            profile +
            " bundle PIN owner, renewal and source retirement"
    );
}

function exerciseLibraryBackupRuntime(profile) {
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath });
    const saved = new Map();
    let accept,
        outcome,
        restarted = 0;
    Object.assign(w, {
        catIndex: 0,
        channels: {
            10: {
                category: { name: "News" },
                itemId: "stream:A",
                legacyChannelId: 100,
            },
        },
        cList: [10],
        confirmBox: (_message, yes) => {
            accept = yes;
        },
        p_pref: "backup-artifact",
        primaryIndex: 0,
        providerDelItem: (key) => saved.delete(key),
        providerGetItem: (key) => saved.get(key) ?? null,
        providerGetJson: (key, fallback) =>
            JSON.parse(saved.get(key) || "null") || fallback,
        providerSetItem: (key, value) => saved.set(key, value),
        restart: () => restarted++,
    });
    w.loadFavoritesLists();
    w.__ottChannels.mount(w);
    const backup = JSON.parse(w.exportSettings());
    assert.equal(backup.version, 2);
    backup.tv.channels.locks = ["stream:A"];
    backup.tv.favorites.lists.lists[backup.tv.favorites.lists.active] = [
        { itemId: "stream:A" },
        { itemId: "stream:missing" },
    ];
    w.importSettings(JSON.stringify(backup), (value) => {
        outcome = value;
    });
    assert.equal(outcome, undefined);
    accept();
    assert.equal(outcome, true);
    assert.equal(restarted, 1);
    const restored = JSON.parse(w.exportSettings());
    assert.deepEqual(restored.tv, backup.tv);
    assert.equal(saved.has("favoritesArray"), false);
    w.importSettings(JSON.stringify(backup), (value) => {
        outcome = value;
    });
    w.p_pref = "backup-replacement";
    accept();
    assert.equal(outcome, false);
    assert.equal(restarted, 1);
    console.log(
        "OK: actual " + profile + " bundle v2 backup and source-bound restore"
    );
}

function exerciseMediaRuntime(profile) {
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath });
    const {
        assertMediaReadContract,
        trackMediaSnapshots,
    } = require("./helpers/media-read-cost.cjs");
    assertMediaReadContract(w);
    const mediaReads = trackMediaSnapshots(w);
    const stored = new Map(),
        played = [],
        rendered = [];
    let position = 0,
        request;
    Object.assign(w, {
        __ottRenderMedia: (view) => rendered.push(view),
        catIndex: 0,
        cats: { All: [1] },
        catsArray: ["All"],
        channels: { 1: { channel_name: "Live" } },
        closeList: () => w.cancelMediaLoad(),
        confirmBox: (_message, accept) => {
            w.confirmMedia = accept;
        },
        curList: [1],
        getMediaArray: (_route, done) => {
            request = done;
        },
        p_pref: "media-artifact",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => stored.get(key) || null,
        providerSetItem: (key, value) => stored.set(key, value),
        sFavorites: 0,
        sInfoSwitch: 0,
        sMedCount: 2,
        sStopPlay: 0,
        stbGetLen: () => 600,
        stbGetPosTime: () => position,
        stbPlay: (url) => {
            played.push(url);
            w.__ottClassicPlayback.command({ type: "playing" });
        },
        stbSetPosTime: (value) => {
            position = value;
        },
    });
    w.mediaList(null);
    w.mediaRecords = [
        { id: 41, stream_url: "expired.mp4", title: "Movie" },
        { playlist_url: "folder", title: "Folder" },
    ];
    request();
    assert.equal(rendered.at(-1).frame.items[0].ref.itemId, "provider:41");
    const mediaRevision = w.__ottMedia.snapshot().revision;
    mediaReads.reset();
    w.__ottMedia.highlight(1, mediaRevision);
    assert.equal(mediaReads.snapshots, 0);
    assert.equal(mediaReads.selects, 0);
    assert.equal(w.__ottMedia.snapshot().frame.selected, 1);
    w.selectMedia(0);
    assert.deepEqual(played, ["expired.mp4"]);
    position = 125.9;
    w.setCurrent(0, -1);
    w.__ottClassicPlayback.command({ type: "stop" });
    w.mediaList(-1);
    w.selectMedia(0);
    w.mediaRecords = [
        { id: 41, stream_url: "renewed.mp4", title: "New title" },
    ];
    request();
    assert.equal(played.at(-1), "renewed.mp4");
    w.confirmMedia();
    assert.equal(position, 120);
    const journal = JSON.parse(stored.get("mediaJournal.v1:media-artifact"));
    assert.equal(journal.history.length, 1);
    assert.equal(journal.history[0].itemId, "provider:41");
    w.mediaList("pending");
    const abandoned = request;
    const count = rendered.length;
    w.cancelMediaLoad();
    w.mediaRecords = [{ id: 99, stream_url: "wrong.mp4", title: "Stale" }];
    abandoned();
    assert.equal(rendered.length, count);
    assert.equal(played.length, 2);
    console.log(
        "OK: actual media library/journal " +
            profile +
            " stable resume and stale cancellation"
    );
}

function exerciseArchiveRuntime(profile) {
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath });
    const now = Math.floor(Date.now() / 1000);
    const programme = {
        name: "Archive fixture",
        time: now - 1800,
        time_to: now + 1800,
    };
    const opened = [];
    const seeks = [];
    const rendered = [];
    const guides = [];
    const items = new Map();
    Object.assign(w, {
        __ottRenderArchive: (model) => rendered.push(model.position),
        catIndex: 0,
        cats: { All: [1, 2] },
        catsArray: ["All"],
        channels: {
            1: { channel_name: "Archive one", rec: 24 },
            2: { channel_name: "Archive two", rec: 24 },
        },
        curProg: -1,
        epgArray: [programme],
        fileArchive: true,
        getArchiveUrl: (id, start, end, item) => {
            assert.equal(id, 1);
            assert.equal(item.name, "Archive fixture");
            assert(end > start);
            return "https://media.invalid/archive.ts";
        },
        getChannelEpgCached: (id, callback) => guides.push({ callback, id }),
        ifParentalAccessChId: () => false,
        p_pref: "archive-artifact:",
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => items.get(key) || null,
        providerSetItem: (key, value) => items.set(key, value),
        settings: { ...w.settings, prevCount: 2 },
        sFavorites: 0,
        sInfoRew: 0,
        sStopPlay: 0,
        stbGetLen: () => 3600,
        stbGetPosTime: () => 0,
        stbPlay: (url, offset) => {
            opened.push({ offset, url });
            w.__ottClassicPlayback.command({ type: "playing" });
        },
        stbSetPosTime: (offset) => {
            seeks.push(offset);
            w.__ottClassicPlayback.command({ type: "playing" });
        },
    });
    w.curList = w.cats.All;
    w.__ottClassicPlayback.command({ channelId: 1, type: "live" });
    w.playArchive(programme.time + 10);
    assert.equal(opened.length, 1, profile + ": actual archive opens a file");
    assert.equal(opened[0].offset, 10);
    w.curProg = 999;
    w.playArchive(programme.time + 25);
    assert.equal(
        opened.length,
        1,
        profile + ": UI index cannot reopen the file"
    );
    assert.deepEqual(seeks, [25]);
    const journal = JSON.parse(items.get("playbackJournal"));
    assert.equal(journal.bookmark.kind, "archive");
    assert.equal(journal.bookmark.archiveStart, programme.time + 25);

    // A programme gap requests a guide refresh. Switching the actual selection
    // retires that callback even if its transport cannot be aborted.
    w.updateArchiveInfo(programme.time_to + 5);
    assert.equal(guides.length, 1);
    w.setCurrent(0, 1, false);
    w.__ottClassicPlayback.command({ channelId: 2, type: "live" });
    const published = rendered.length;
    const selection = w.primaryIndex;
    guides[0].callback(1, [
        { name: "Retired programme", time: now, time_to: now + 9000 },
    ]);
    assert.equal(rendered.length, published);
    assert.equal(w.primaryIndex, selection);
    assert.equal(w.__ottClassicPlayback.snapshot().target.kind, "live");
    w.__ottClassicPlayback.cancel();
}

function exercisePlaybackRuntime(w, profile) {
    const timers = fixtureTimers.get(w);
    const stored = new Map();
    const positions = [];
    const archives = [];
    const overrides = {
        _prog100: { name: "Current program" },
        catIndex: 0,
        cats: { All: [1, 2] },
        catsArray: ["All"],
        channels: {
            1: { channel_name: "One", rec: 24 },
            2: { channel_name: "Two", rec: 24 },
        },
        curList: [1, 2],
        medHistory: [{ stream_url: "https://media.invalid/movie.mp4" }],
        p_pref: "artifact-fixture:",
        playArchive: (start) => archives.push(start),
        playTime: 0,
        playType: 0,
        prevArr: [],
        primaryIndex: 0,
        providerGetItem: (key) => stored.get(key) || null,
        providerSetItem: (key, value) => stored.set(key, value),
        settings: { ...w.settings, prevCount: 2 },
        sFavorites: 0,
        showShift() {},
        sInfoRew: 0,
        stbGetLen: () => 120,
        stbGetPosTime: () => 40,
        stbSetPosTime: (position) => positions.push(position),
    };
    const saved = new Map(Object.keys(overrides).map((key) => [key, w[key]]));
    function delayedShift(...deltas) {
        const before = new Set(timers.keys());
        deltas.forEach((delta) => w.shiftArchive(delta));
        const pending = [...timers].filter(
            ([id, timer]) => !before.has(id) && timer.delay === 500
        );
        assert.equal(
            pending.length,
            1,
            profile + ": built shiftArchive owns one delayed operation"
        );
        return pending[0];
    }
    function fire([id, timer]) {
        timers.delete(id);
        timer.fn();
    }
    try {
        for (const [key, value] of Object.entries(overrides)) w[key] = value;
        w.curList = w.cats.All;
        // Execute the real bundled entrypoint, codec, controller and Kotlin core.
        w.setCurrent(0, 1, false);
        assert.equal(w.primaryIndex, 1);
        assert.equal(w.curList, w.cats.All);
        assert.deepEqual(
            Array.from(w.prevArr, (visit) => visit.ci),
            [1]
        );
        w.__ottClassicPlayback.command({ channelId: 2, type: "live" });
        assert.equal(stored.get("primaryIndex"), "1");
        assert.equal(JSON.parse(stored.get("continueWatch")).channelId, 2);
        const journal = JSON.parse(stored.get("playbackJournal"));
        assert.equal(
            journal.version,
            2,
            profile + ": real setCurrent writes the canonical journal"
        );
        assert.equal(journal.sourceId, "artifact-fixture:");
        assert.equal(journal.history[0].channelId, "1");
        assert.equal(journal.history[0].kind, "live");
        w.__ottClassicPlayback.command({ channelId: 2, type: "live" });
        const checkpoint = JSON.parse(stored.get("playbackJournal"));
        assert.equal(checkpoint.bookmark.channelId, "2");
        assert.equal(checkpoint.bookmark.kind, "live");

        const media = w.__ottMedia.prepare(
            {
                id: "movie",
                stream_url: "https://media.invalid/movie.mp4",
                title: "Movie",
            },
            "https://media.invalid/movie.mp4"
        );
        w.__ottClassicPlayback.command({
            channelId: media.ref.itemId,
            item: media.item,
            sourceId: media.ref.sourceId,
            type: "vod",
        });
        w.__ottClassicPlayback.command({ type: "playing" });
        const combined = delayedShift(5, 7);
        assert.deepEqual(positions, [], profile + ": seek waits for debounce");
        fire(combined);
        assert.deepEqual(
            positions,
            [52],
            profile + ": actual typed controller combines offsets"
        );

        const cancelled = delayedShift(10);
        w.__ottClassicPlayback.cancel();
        assert.equal(timers.has(cancelled[0]), false);
        fire(cancelled); // A browser callback may already have entered its task queue.
        assert.deepEqual(
            positions,
            [52],
            profile + ": cancellation rejects queued callback"
        );

        const changedSelection = delayedShift(10);
        w.setCurrent(0, 0, false);
        fire(changedSelection);
        assert.deepEqual(
            positions,
            [52],
            profile + ": built setCurrent retires pending seek"
        );
        assert.equal(
            JSON.parse(stored.get("mediaJournal.v1:" + media.ref.sourceId))
                .history[0].position,
            40,
            profile + ": leaving VOD persists position"
        );

        const changedCatalog = delayedShift(10);
        w.channels = {
            1: { channel_name: "Replacement", rec: 24 },
            2: { channel_name: "Two", rec: 24 },
        };
        fire(changedCatalog);
        assert.deepEqual(
            positions,
            [52],
            profile + ": same channel ID in new catalog cannot accept old seek"
        );

        const archiveStart = Math.floor(Date.now() / 1000) - 600;
        w.playType = archiveStart;
        w.playTime = 30;
        fire(delayedShift(15));
        assert.deepEqual(
            archives,
            [archiveStart + 45],
            profile + ": archive planning reaches the host effect port"
        );
    } finally {
        w.__ottClassicPlayback.cancel();
        for (const [key, value] of saved) w[key] = value;
    }
}

function exerciseProviderRuntime(profile) {
    // A fresh full artifact realm keeps this startup test independent of both
    // previous smoke overrides and any source-module bootstrap.
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath, timeout: 5000 });
    assertProvidersUnloaded(w, profile);
    assertPrivateRuntime(w, profile);
    w.document.createTextNode = (text) => ({ nodeType: 3, textContent: text });
    const stored = new Map([
        ["ottplayprov", "demo"],
        [
            "xtreamxtream_data",
            JSON.stringify({
                password: "secret",
                server: "https://account.test",
                username: "viewer",
            }),
        ],
    ]);
    const requests = [],
        scripts = [],
        providerAssets = [],
        pendingProviderAssets = [],
        scriptCallbacks = [],
        errors = [];
    let deferProviderAssets = false;
    const appendChild = w.document.body.appendChild;
    w.document.body.appendChild = function (child) {
        const result = appendChild.call(this, child);
        if (child.tagName === "SCRIPT") {
            const match = /\/dist\/provider-([a-z0-9]+)\.js\?[^/]*$/.exec(
                child.src
            );
            assert(
                match,
                "Managed loader requested an unexpected asset: " + child.src
            );
            providerAssets.push(match[1]);
            const complete = () => {
                loadProviderBundle(w, match[1]);
                child.onload();
            };
            if (deferProviderAssets) pendingProviderAssets.push(complete);
            else complete();
        }
        return result;
    };
    let completed = 0,
        ajaxWrites = 0;
    const ajax = (settings) => {
        let success, failure;
        const request = {
            abort() {
                this.aborts++;
                if (failure) failure();
            },
            aborts: 0,
            done(callback) {
                success = callback;
                return this;
            },
            fail(callback) {
                failure = callback;
                return this;
            },
            reject() {
                failure();
            },
            resolve(value) {
                success(value);
            },
            settings,
        };
        requests.push(request);
        return request;
    };
    let currentAjax = ajax;
    Object.defineProperty(w.$, "ajax", {
        configurable: true,
        get: () => currentAjax,
        set(value) {
            ajaxWrites++;
            currentAjax = value;
        },
    });
    Object.assign(w, {
        _: (value) => value,
        beginPortChannelIdMigration() {},
        cancelMediaLoad() {},
        cancelPortChannelIdMigration() {},
        closeList() {},
        console: {
            debug() {},
            error: (error) => errors.push(error),
            info() {},
            log() {},
            warn() {},
        },
        finishPortChannelIdMigration() {},
        getDefaultPlayerMode: () => 0,
        getScriptDOM(url, callback) {
            scripts.push(url);
            scriptCallbacks.push(callback);
        },
        invalidateEpgCache() {},
        normalizePlayerMode: (value) => value,
        onChannelsLoaded: () => completed++,
        removeOption() {},
        restoreDemoMute() {},
        savedPopup: {
            popupActions: [
                w.toggleProviderSettingsVisibility,
                () => {},
                w.optionsList,
            ],
            popupArray: ["", "", "Settings"],
            popupDetail: ["", "", "Settings"],
            ver: "artifact",
        },
        setPlayer() {},
        setPlayerMode() {},
        showPage() {},
        stbDelItem: (key) => stored.delete(key),
        stbGetItem: (key) => (stored.has(key) ? stored.get(key) : null),
        stbIsPlaying: () => false,
        stbSetItem: (key, value) => stored.set(key, String(value)),
        stbStopPip() {},
    });
    w.loadProv();
    assert.equal(w.__ottActiveProviderDriver.id, "demo");
    assert.equal(
        completed,
        1,
        profile + ": built demo route completes channel startup"
    );
    assert.equal(w.commandChannelsReady, true);
    assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
    assert.equal(
        w.getChannelUrl(w.cList[0]),
        "https://liminal-sketch-vv8r.here.now/demo/pattern.mp4"
    );
    assert.deepEqual(scripts, []);
    assert.equal(requests.length, 0);
    stored.set("ottplayprov", "xtream");
    w.loadProv("xtream");
    assert.equal(w.__ottActiveProviderDriver.id, "xtream");
    assert.equal(requests.length, 1);
    assert.equal(w.commandChannelsReady, false);
    assert.equal(
        requests[0].settings.url,
        "https://account.test/player_api.php?username=viewer&password=secret"
    );
    requests[0].resolve({
        live_streams: [{ name: "Artifact channel", stream_id: 7 }],
    });
    assert.equal(completed, 2);
    assert.equal(w.commandChannelsReady, true);
    assert.equal(
        w.getChannelUrl(w.cList[0]),
        "https://account.test/live/viewer/secret/7.m3u8"
    );
    w.loadChannels();
    assert.equal(requests.length, 2);
    w.loadProv("demo");
    assert.equal(requests[1].aborts, 1);
    requests[1].resolve({
        live_streams: [{ name: "Obsolete account", stream_id: 8 }],
    });
    assert.equal(completed, 3);
    assert.equal(w.commandChannelsReady, true);
    assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
    if (w.__ottProviderDrivers.registry.has("all4you")) {
        stored.set(
            "all4youcfg",
            JSON.stringify({
                m3u: "",
                pass: "secret",
                server: "https://generic.test",
                user: "account",
            })
        );
        stored.set("ottplayprov", "all4you");
        w.loadProv("all4you");
        assert.equal(requests.length, 3);
        requests[2].reject();
        assert.equal(
            requests.length,
            4,
            profile + ": generic API failure starts playlist fallback"
        );
        requests[3].reject();
        assert.equal(requests.length, 5);
        assert.equal(requests[4].settings.method, "post");
        assert(requests[4].settings.url.endsWith("/m3u/cp.php"));
        requests[4].resolve(
            '#EXTM3U\n#EXTINF:-1 group-title="Generic",Fallback channel\nhttps://media.test/generic\n'
        );
        assert.equal(completed, 4);
        assert.equal(w.getChannelUrl(w.cList[0]), "https://media.test/generic");
        w.loadChannels();
        w.loadProv("demo");
        assert.equal(requests[5].aborts, 1);
        requests[5].reject();
        assert.equal(
            requests.length,
            6,
            profile + ": retired generic failure cannot start a fallback"
        );
        assert.equal(completed, 5);
        assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
    }
    if (w.__ottProviderDrivers.registry.has("1ott")) {
        for (const [id, values] of [
            ["1ott", { "1ottid": "account", "1ottpin": "pin" }],
            ["only4", { o4token: "1234567890" }],
            ["shara-tv", { shtvlogin: "12345678", shtvpass: "abcdefgh" }],
            [
                "tvteam",
                { tvteamwww: "https://tv.team/pl/11/account/playlist.m3u8" },
            ],
            [
                "bestlist/stalker",
                {
                    bestlist_stalkercfg: JSON.stringify({
                        m3u: "https://list.test/tv.m3u",
                        pass: "",
                        server: "",
                        user: "",
                    }),
                },
            ],
        ]) {
            for (const [key, value] of Object.entries(values))
                stored.set(key, value);
            stored.set("ottplayprov", id);
            const start = requests.length;
            const before = completed;
            w.loadProv(id);
            assertProviderMenuIds(w, id);
            assert.equal(w.__ottActiveProviderDriver.id, id);
            if (id === "1ott") requests[start].resolve('{"token":"artifact"}');
            requests.at(-1).reject();
            assert.equal(
                requests.at(-1).settings.method,
                "post",
                id + ": playlist proxy retry"
            );
            requests
                .at(-1)
                .resolve(
                    '#EXTM3U\n#EXTINF:-1 tvg-id="guide" tvg-name="channel" group-title="Live",Named provider\nhttps://media.test/token/channel/index.m3u8?token=t\n'
                );
            assert.equal(
                completed,
                before + 1,
                id + ": real artifact startup completes"
            );
            assert(
                w.cList.length > 0,
                id + ": actual parsed catalog is published"
            );
            assert(w.getChannelUrl(w.cList[0]), id + ": playable stream URL");
            w.loadChannels();
            const pending = requests.at(-1);
            w.loadProv("demo");
            assert.equal(pending.aborts, 1);
            const count = requests.length;
            pending.reject();
            pending.resolve("stale");
            assert.equal(requests.length, count, id + ": no stale retry");
            assert.equal(completed, before + 2);
            assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
        }
    }
    stored.set(
        "stalkerstalker_data",
        JSON.stringify({
            mac: "00:1A:2B:3C:4D:5E",
            portal: "https://portal.test/",
        })
    );
    stored.set("ottplayprov", "stalker");
    let before = completed;
    const beforeStalker = requests.length;
    deferProviderAssets = true;
    w.loadProv("stalker");
    assert.equal(w.__ottStalkerDriver, undefined);
    assert.equal(w.__ottActiveProviderDriver, null);
    assert.equal(requests.length, beforeStalker);
    assert.equal(pendingProviderAssets.length, 1);
    pendingProviderAssets.shift()();
    deferProviderAssets = false;
    assert.equal(w.__ottActiveProviderDriver.id, "stalker");
    assert.equal(requests.at(-1).settings.contentType, "application/json");
    requests.at(-1).resolve({ result: {} });
    requests.at(-1).resolve({
        result: [
            {
                archive: 24,
                id: 42,
                logo: "/logo.png",
                name: "Portal channel",
                url: "https://live.test/42",
            },
        ],
    });
    assert.equal(completed, before + 1);
    assert.equal(w.getChannelUrl(w.cList[0]), "https://live.test/42");
    const guides = [];
    w.getChannelEpg(42, (id, rows) => guides.push([id, rows]));
    requests.at(-1).resolve({
        result: [{ end: 20, name: "Programme", start: 10 }],
    });
    assert.equal(guides.length, 1);
    assert.equal(guides[0][0], 42);
    assert.equal(guides[0][1][0].name, "Programme");
    w.loadChannels();
    let pending = requests.at(-1);
    const abortStalker = pending.abort.bind(pending);
    pending.abort = () => {
        abortStalker();
        w.loadProv("demo");
    };
    w.loadProv("xtream");
    assert.equal(
        w.__ottActiveProviderDriver.id,
        "demo",
        "the newer selection made during abort owns the actual built runtime"
    );
    assert.equal(pending.aborts, 1);
    let count = requests.length;
    pending.resolve({ result: {} });
    assert.equal(
        requests.length,
        count,
        "obsolete Stalker cannot load catalog"
    );
    assert.equal(completed, before + 2);

    for (const id of ["itv", "ottclub", "shura"]) {
        if (!w.__ottProviderDrivers.registry.has(id)) continue;
        const prefix = { itv: "itv", ottclub: "", shura: "sh" }[id];
        for (const [key, value] of Object.entries({
            key: id === "shura" ? "12345678" : "1234567890",
            mpeg: "0",
            ottkey: "12345678",
            ottwww: "operator.test",
            server: "2",
        }))
            stored.set(prefix + key, value);
        stored.set("ottplayprov", id);
        before = completed;
        w.loadProv(id);
        assertProviderMenuIds(w, id);
        assert.equal(w.__ottActiveProviderDriver.id, id);
        if (id === "itv")
            requests.at(-1).resolve({
                channels: [
                    {
                        cat_name: "News",
                        ch_id: "one",
                        channel_name: "One",
                        rec_time: 24,
                        server_cdn: "cdn.test",
                        token: "t",
                    },
                ],
            });
        else if (id === "ottclub")
            requests.at(-1).resolve(
                JSON.stringify({
                    one: {
                        category: "News",
                        ch_id: "one",
                        channel_name: "One",
                        img: "one.png",
                        name: "Provider programme",
                        rec: true,
                        time: Date.now() / 1000 - 60,
                        time_to: Date.now() / 1000 + 3600,
                    },
                })
            );
        else {
            assert.equal(requests.at(-1).settings.dataType, "jsonp");
            requests.at(-1).resolve([{ archive: 24, id: "one", name: "One" }]);
            requests
                .at(-1)
                .resolve(
                    '#EXTM3U\n#EXTINF:-1 tvg-name="one" group-title="News",One\nhttp://v.test/token/one/a.ts'
                );
        }
        assert.equal(completed, before + 1, id + ": built catalog completes");
        assert.equal(w.cList.length, 1);
        assert(w.getChannelUrl(w.cList[0]), id + ": built live URL");
        assert(w.__ottActiveProviderDriver.archive("one", 10, 20));
        if (id === "ottclub") {
            assert.equal(
                w.channels.one.name,
                "Provider programme",
                "OTTCLUB seed publishes the owned current programme"
            );
            assert.equal(
                w.__ottClassicGuide.peek("one"),
                null,
                "Disabled cache does not retain a separate raw catalog schedule"
            );
            assert.equal(w.__ottActiveProviderDriver.guideCurrent, undefined);
        } else {
            const current = [];
            w.sNextCount = 2;
            w.getCurrentChannelEpg("one", (channel, rows) =>
                current.push([channel, rows])
            );
            const request = requests.at(-1);
            assert(
                request.settings.url.includes(
                    id === "itv" ? "/epg/" : "/pf.jsonp"
                )
            );
            request.resolve([]);
            assert.equal(current.length, 1);
            assert.equal(current[0][0], "one");
        }
        if (id === "itv") {
            w.popupArray = [];
            w.popupActions = [];
            w.popupDetail = [];
            w.duneAddSettings(0);
            const open = w.popupActions[2];
            open();
            pending = requests.at(-1);
            assert(pending.settings.url.endsWith("/data/1234567890"));
            const close = w.aboutKeyHandler;
            open();
            assert.equal(pending.aborts, 1);
            assert.equal(
                close(),
                false,
                "old panel handler cannot close replacement"
            );
            requests.at(-1).resolve({
                package_info: [{ name: "Sport" }],
                user_info: { login: "<viewer>", pay_system: 1 },
            });
            const html = w.$("#listAbout").html();
            assert(html.includes("&lt;viewer&gt;"));
            assert(html.includes("Sport"));
            pending.resolve({ user_info: { login: "stale" } });
            assert.equal(w.$("#listAbout").html(), html);
            w.aboutKeyHandler();
        }
        w.loadChannels();
        pending = requests.at(-1);
        w.loadProv("demo");
        assert.equal(pending.aborts, 1);
        count = requests.length;
        pending.resolve(null);
        pending.reject();
        assert.equal(requests.length, count, id + ": no obsolete fallback");
        assert.equal(completed, before + 2);
        assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
    }
    // The last four shipped providers also run through the artifact registry.
    w.stb = { ...w.stb, getMacAddress: () => "00:11:22:33:44:55" };
    for (const [id, values, playlist] of [
        [
            "antifriz",
            { azkey: "12345678", azmpeg: "0" },
            '#EXTM3U\n#EXTINF:-1 tvg-id="e" tvg-rec="2" group-title="News",One\nhttp://cdn.test/live/token/42.m3u8\n',
        ],
        [
            "kb-team",
            { kbcv_list: "0" },
            '#EXTM3U\n#EXTINF:-1 tvg-id="e" tvg-name="Guide One" group-title="ХХХ" catchup-days="2",One\nhttps://stream.test/token/one/index.m3u8\n',
        ],
        [
            "edem",
            {
                ededcdn: "https://cdn.test/path",
                edkey: "12345678",
                edlist: "0",
                edvpurl: "portal::[key:secret]https://portal.test/api",
            },
            '#EXTM3U\n#EXTINF:-1 tvg-id="epg42" group-title="News",One\nhttps://localhost/00000000000000/live/42/index.m3u8\n',
        ],
        [
            "m3u",
            {
                m3um3uArr: JSON.stringify({
                    active: 0,
                    M3Us: [
                        {
                            rechours: "48",
                            www: "https://playlist.test/one.m3u",
                        },
                        {
                            rechours: "24",
                            www: "https://playlist.test/two.m3u",
                        },
                    ],
                }),
            },
            '#EXTM3U\n#EXTINF:-1 tvg-id="e" group-title="News",One\nhttps://stream.test/token/one/index.m3u8\n',
        ],
    ]) {
        if (!w.__ottProviderDrivers.registry.has(id)) continue;
        for (const [key, value] of Object.entries(values))
            stored.set(key, value);
        stored.set("ottplayprov", id);
        before = completed;
        const start = requests.length;
        w.loadProv(id);
        assertProviderMenuIds(w, id);
        assert.equal(w.__ottActiveProviderDriver.id, id);
        assert.equal(
            requests.length,
            start + 1,
            id + ": initial owned request"
        );
        requests[start].resolve(playlist);
        assert.equal(
            completed,
            before + 1,
            id + ": artifact startup completes once"
        );
        assert.equal(w.cList.length, 1);
        const channel = w.cList[0];
        assert(w.getChannelUrl(channel), id + ": artifact live URL");
        const driver = w.__ottActiveProviderDriver;
        if (id === "kb-team") {
            const guide = requests.find(
                (r, i) => i > start && r.settings.url.includes("gelist.php")
            );
            const logo = requests.find(
                (r, i) => i > start && r.settings.url.includes("geicons.php")
            );
            assert(guide && logo);
            guide.resolve({ [channel]: "guide/path" });
            logo.resolve({ [channel]: "https://logo.test/one.png" });
            assert.equal(w.channels[channel].logo, "https://logo.test/one.png");
            assert.equal(
                completed,
                before + 1,
                "metadata patch cannot repeat startup"
            );
            assert.equal(w.p_pref, "kbc0");
        }
        if (id === "antifriz" || id === "kb-team") {
            w.mediaUrls = ["https://catalog.test/root.json"];
            let mediaCalls = 0;
            w.getMediaArray(w.mediaUrls[0], () => mediaCalls++);
            requests
                .at(-1)
                .resolve(
                    '{"playlist_name":"Films","channel":{"title":"Film","stream_url":"https://stream.test/film"}}'
                );
            assert.equal(mediaCalls, 1);
            assert.equal(w.mediaRecords.length, 1);
            assert.equal(
                w.mediaRecords[0].stream_url,
                "https://stream.test/film"
            );
        }
        if (id === "edem") {
            w.sPageSize = 10;
            let mediaCalls = 0;
            w.getMediaArray("", () => {
                mediaCalls++;
                w._mediaLoadState = { records: w.mediaRecords };
                w.listArray = w.mediaRecords;
            });
            requests.at(-1).resolve({
                count: 106,
                items: [{ title: "One", type: "stream" }, { type: "next" }],
                type: "category",
            });
            assert.equal(mediaCalls, 1);
            const rows = w.mediaRecords;
            assert.equal(rows.length, 106);
            w.selIndex = 101;
            rows[101].description();
            assert.equal(JSON.parse(requests.at(-1).settings.data).offset, 100);
            requests.at(-1).resolve({
                items: [
                    { title: "Two", type: "stream" },
                    { title: "Three", type: "stream" },
                ],
            });
            assert.strictEqual(w.mediaRecords, rows);
            assert.strictEqual(w.listArray, rows);
            assert.equal(rows[101].title, "Three");
        }
        if (id === "m3u") {
            for (let slot = 0; slot < 2; slot++) {
                const cfg = driver.configuration();
                cfg.active = slot;
                driver.saveConfiguration(cfg);
                w.providerSetItem("playbackJournal", "slot" + slot);
                assert.equal(
                    stored.get("m3uplaybackJournal" + (slot || "")),
                    "slot" + slot
                );
                assert.equal(w.m3uArr.active, slot);
            }
        }
        w.loadChannels();
        pending = requests.at(-1);
        w.loadProv("demo");
        assert.equal(
            pending.aborts,
            1,
            id + ": pending request aborts on replacement"
        );
        count = requests.length;
        pending.resolve(playlist);
        pending.reject();
        assert.equal(
            requests.length,
            count,
            id + ": late result starts no request"
        );
        assert.equal(completed, before + 2);
        assert.deepEqual(Array.from(w.cList), [900000001, 900000002]);
    }
    if (w.__ottProviderDrivers.registry.has("edem")) {
        const translate = w._;
        let replaced = false;
        w._ = (value) => {
            if (!replaced && value === "epg.one (Standard)") {
                replaced = true;
                w.loadProv("demo");
            }
            return translate(value);
        };
        w.loadProv("edem");
        w._ = translate;
        assert(replaced);
        assert.equal(w.__ottActiveProviderDriver.id, "demo");
        // The serialized host finishes the queued Demo selection after mount returns.
        assert.equal(w.getMediaArray, null);
        assert.strictEqual(w.playMedia, w._playMedia);
    }
    // A media-playlist provider loads its own family and offers configuration
    // before it has credentials or selected roots; it fabricates no channels.
    w.listCaptionElement = w.document.getElementById("listCaption");
    w.listCaption = w.listCaptionElement;
    w.listDetail = w.document.getElementById("listDetail");
    w.listFooter = w.document.getElementById("listFooter");
    for (const id of ["plex", "vportal"]) {
        stored.set("ottplayprov", id);
        w.loadProv(id);
        assert.equal(w.__ottActiveProviderDriver.id, id);
        assert.equal(
            w.__ottActiveProviderDriver.capabilities.libraryOnly,
            false
        );
        assert.equal(
            w.__ottActiveProviderDriver.capabilities.mediaPlaylist,
            true
        );
        assert.equal(w.__ottActiveProviderDriver.libraryReady(), false);
    }
    w.loadProv("demo");
    assert.deepEqual(
        scripts,
        [],
        profile + ": registered drivers never execute provider scripts"
    );
    assert.deepEqual(
        providerAssets.slice().sort(),
        providerKinds().slice().sort(),
        profile +
            ": provider switching loads each required real family asset once"
    );
    assertProviderFactories(w, profile);
    assert.equal(
        ajaxWrites,
        0,
        profile + ": registered drivers never patch the ajax host port"
    );
    assert.deepEqual(errors, []);
    w.listCaptionElement = w.document.getElementById("listCaption");
    w.listDetail = w.document.getElementById("listDetail");
    w.listFooter = w.document.getElementById("listFooter");
    const requestCount = requests.length;
    for (const selection of ["stored", "url"]) {
        stored.set(
            "ottplayprov",
            selection === "stored" ? "unknown/provider" : ""
        );
        w.location.search = selection === "url" ? "?unknown/provider" : "";
        w.loadProv();
        assert.equal(w.listCaptionElement.innerHTML, "First Run Setup");
        assert.equal(w.__ottActiveProviderDriver, null);
        assert.deepEqual(
            scripts,
            [],
            profile + ": unknown ID never loads a script"
        );
        assert.equal(
            requests.length,
            requestCount,
            profile + ": unknown ID never makes a request"
        );
    }
    w.location.search = "";
    const driverRegistry = w.__ottProviderDrivers.registry;
    const hasDriver = driverRegistry.has;
    const alerts = [];
    w.alert = (message) => alerts.push(message);
    driverRegistry.has = (id) => (id === "demo" ? false : hasDriver(id));
    try {
        w.loadProv("demo");
        assert.deepEqual(alerts, ["Failed to load! (demo)"]);
        assert.equal(w.listCaptionElement.innerHTML, "First Run Setup");
        assert.equal(w.__ottActiveProviderDriver, null);
        assert.deepEqual(
            scripts,
            [],
            profile + ": missing managed driver never loads its retired script"
        );
        assert.equal(requests.length, requestCount);
    } finally {
        driverRegistry.has = hasDriver;
    }
    if (!playDistribution) {
        let customLoads = 0;
        w.loadChannels = () => customLoads++;
        w.showEditKey = () => {};
        w.edit_dealer();
        w.editvar = "custom:artifact-code";
        w.setEdit();
        w.doDealer = (value) => {
            assert.equal(value, "custom:artifact-code");
            w.providerIds.push("custom/dealer");
            stored.set("ottplayprov", "custom/dealer");
            w.loadProv();
        };
        scriptCallbacks[0]();
        assert.equal(scripts.length, 2);
        assert(scripts[0].includes("/d/custom.js?"));
        assert(scripts[1].includes("/prov/custom/dealer/prov.js?"));
        assert.equal(driverRegistry.has("custom/dealer"), false);
        w.duneAddSettings = () => {};
        w.getChannelUrl = () => "https://media.test/custom.m3u8";
        scriptCallbacks[1]();
        assert.equal(customLoads, 1);
        const retiredUrl = w.getChannelUrl;
        assert.equal(retiredUrl(), "https://media.test/custom.m3u8");
        w.loadProv("demo");
        assert.equal(customLoads, 2);
        assert.equal(w.__ottActiveProviderDriver.id, "demo");
        assert.equal(
            retiredUrl(),
            undefined,
            profile +
                ": replacing a custom provider retires its script callbacks"
        );
        assert.equal(scripts.length, 2);
        assert.deepEqual(errors, []);
    }
    require("./helpers/credential-reentry.cjs").assertCredentialReentry(
        w,
        stored,
        requests
    );
    console.log(
        "OK: actual classic bundle " +
            profile +
            " instance provider startup/cancellation"
    );
}

function exerciseScreenRuntime(profile) {
    const w = fixture(profile);
    vm.runInContext(bundle, w, { filename: bundlePath, timeout: 5000 });
    assertMenuRuntime(w.__ottMenuRegistry);
    const originalQuery = w.$;
    const visible = {};
    w.$ = function (selector) {
        const chain = originalQuery(selector);
        chain.is = () => !!visible[selector];
        chain.show = function () {
            visible[selector] = true;
            return chain;
        };
        chain.hide = function () {
            visible[selector] = false;
            return chain;
        };
        return chain;
    };
    const actions = [];
    w.changeSelect = (delta) => actions.push(["move", delta]);
    w.listArray = ["a", "b"];
    w.listDataArray = w.listArray;
    w.listKeyHandlerFn = () => false;
    const list = w.__ottClassicScreenPort.commitList();
    const key = (code) =>
        w.keyHandler({
            keyCode: code,
            preventDefault() {},
            stopPropagation() {},
        });
    key(w.keys.DOWN);
    assert.deepEqual(actions, [["move", 1]]);
    let confirmed = 0;
    w.stbIsPlaying = () => true;
    w.confirmBox("First", () => w.confirmBox("Second", () => confirmed++));
    const stale = w.dialogBoxKeyHandler;
    key(w.keys.ENTER);
    stale(w.keys.ENTER);
    assert.equal(confirmed, 0);
    key(w.keys.ENTER);
    assert.equal(confirmed, 1);
    assert.equal(list.active(), true);
    w.__ottClassicScreenPort.invalidate();
    assert.equal(list.active(), false);
    stale(w.keys.ENTER);
    assert.equal(confirmed, 1);
    const records = w.__ottMenuRegistry.importClassic(w);
    assert(records.some((record) => record.id === "settings.open"));
    assert(records.some((record) => record.id === "favorites.open"));
    console.log(
        "OK: actual " + profile + " bundle screen/input/menu ownership"
    );
}

async function main() {
    // The bundle reassigns ott_device after HTML boot has already detected it.
    // Exercise that assignment with the webOS TV 25 UA published by LG:
    // https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine
    const webosUA =
        "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.270 Safari/537.36 WebAppManager";
    for (const [pathname, userAgent, expected] of [
        ["/", webosUA, "lg/webos"],
        ["/", "webOS TV", "lg/webos"],
        ["/f/lg/webos", "Unknown browser", "lg/webos"],
        ["/f/lg/webos/", "Unknown browser", "lg/webos"],
        ["/f/lg/netcast/", webosUA, "lg/netcast"],
        ["/f/samsung/tizen/", webosUA, "samsung/tizen"],
        ["/f/samsung/maple/", "Unknown browser", "samsung/maple"],
        ["/f/dune/", webosUA, "dune"],
        ["/", "Unknown browser", "pc"],
    ]) {
        const w = fixture("modern");
        w.location.pathname = pathname;
        w.location.href = w.location.origin + pathname;
        w.navigator.userAgent = userAgent;
        w.ott_device = expected;
        vm.runInContext(bundle, w, { filename: bundlePath, timeout: 5000 });
        assert.equal(
            w.__OTT_CONTROL_DISCOVERY_VERSION__,
            1,
            "discovery deployment capability is installed"
        );
        assert.equal(typeof w.__ottControlDiscovery.start, "function");
        assert.equal(
            w.ott_device,
            expected,
            pathname + ": bundle must preserve the boot device selection"
        );
        // This is the device URL requested by HTML after the bundle's onload.
        const adapterPath = "devices/" + w.ott_device + "/device.js";
        const adapter = fs.readFileSync(
            path.join(__dirname, "..", adapterPath),
            "utf8"
        );
        vm.runInContext(adapter, w, { filename: adapterPath });
        if (expected === "lg/webos") {
            assert.equal(w.keys.RETURN, 461, "Load the LG Back key mapping");
        }
    }
    console.log(
        "OK: actual classic bundle retains LG UA and nested device routes"
    );

    for (const profile of [
        "legacy",
        "modern",
        "capacitor-fallback",
        "capacitor-native",
    ]) {
        const w = fixture(profile);
        const bootstrapRuntime = {
            apply: w.applyWebRuntimePolyfills,
            encoder: w.TextEncoder,
            now: w.performance.now,
        };
        w.__cv = "dev_1790460000000_abcd1234";
        w.__av = "1.1.45-beta.29";
        try {
            vm.runInContext(bundle, w, { filename: bundlePath, timeout: 5000 });
        } catch (error) {
            throw new Error(
                profile + " bundle execution failed: " + error.message,
                { cause: error }
            );
        }
        assert.equal(
            w.__cv,
            "dev_1790460000000_abcd1234",
            "provider modules keep the HTML boot cache key"
        );
        assert.equal(
            w.__av,
            "1.1.45-beta.29",
            "assets keep the HTML release cache key"
        );
        assert.equal(
            w.TextEncoder,
            bootstrapRuntime.encoder,
            profile + ": retain bootstrap encoder"
        );
        assert.equal(
            w.performance.now,
            bootstrapRuntime.now,
            profile + ": retain bootstrap clock"
        );
        assert.equal(
            w.applyWebRuntimePolyfills,
            bootstrapRuntime.apply,
            profile + ": do not redefine bootstrap installer"
        );
        vm.runInContext(
            `
            (function () {
                var originalOffset = Date.getTimezoneOffset();
                Date.setTimezoneOffset(-180);
                applyPolyfills();
                if (Date.getTimezoneOffset() !== -180 || new Date(0).getHours() !== 3 || new Date(0).getTime() !== 0)
                    throw Error("Repeated initialization changed the selected timezone");
                Date.setTimezoneOffset(originalOffset);
            }());
        `,
            w
        );
        assertProvidersUnloaded(w, profile);
        assertPrivateRuntime(w, profile);
        for (const kind of providerKinds()) loadProviderBundle(w, kind);
        assertProviderFactories(w, profile);
        assertPrivateRuntime(w, profile);
        if (profile === "modern" || profile === "legacy") {
            assertLzWire(w);
            assertQrSvg(
                w,
                "https://ott.example/invite?name=Телевизор&token=abc-123"
            );
            exerciseCloudRuntime(profile);
            await exerciseAccessRuntime(profile);
            exerciseLibraryBackupRuntime(profile);
            exerciseScreenRuntime(profile);
            exercisePlaybackRuntime(w, profile);
            exerciseArchiveRuntime(profile);
            exerciseMediaRuntime(profile);
            exerciseProviderRuntime(profile);
        }
        for (const name of [
            "startPlayer",
            "stbInit",
            "stbPlay",
            "stbStop",
            "keyHandler",
            "playArchive",
            "playChannel",
            "playMedia",
            "showSelectBox",
            "handleCommand",
            "settingsCommands",
            "resolveNativePlugin",
            "noProvParam",
            "optionsList",
        ]) {
            assert.equal(
                typeof w[name],
                "function",
                profile + ": missing global " + name
            );
        }
        assert.equal(
            Array.isArray(w.popupActions),
            true,
            profile + ": public popup action table"
        );
        assert.equal(
            w.chanels,
            w.channels,
            profile + ": legacy channel alias keeps the actual table"
        );
        assert.ok(
            w.optionsArr.some(
                (item) =>
                    item.name === "Remote control" &&
                    item.action === w.settingsCommands
            ),
            profile + ": final options wiring must execute"
        );
        assert.equal(
            Array.isArray(w.listDataArray),
            true,
            profile + ": listDataArray must remain an array"
        );
        for (const name of [
            "listKeyHandlerFn",
            "getListItemFn",
            "detailListActionFn",
            "aboutKeyHandler",
        ]) {
            assert.ok(
                w[name] === null || typeof w[name] === "function",
                profile +
                    ": callback " +
                    name +
                    " has been replaced with a wrapper object"
            );
        }
        const callback = function () {
            return true;
        };
        w.listKeyHandler = callback;
        assert.equal(
            w.listKeyHandlerFn,
            callback,
            profile + ": public list callback must reach its backing global"
        );
        w.listKeyHandlerFn = null;
        assert.equal(
            w.listKeyHandler,
            null,
            profile + ": reverse list callback alias must stay synchronized"
        );
        w.getListItemFn = callback;
        assert.equal(
            w.getListItem,
            callback,
            profile + ": item renderer alias must stay synchronized"
        );
        w.detailListAction = callback;
        assert.equal(
            w.detailListActionFn,
            callback,
            profile + ": detail callback alias must stay synchronized"
        );
        for (const pair of w.legacyPlayerBindings) {
            assert.equal(
                w[pair[0]],
                w[pair[1]],
                profile + ": shared naming alias " + pair[0]
            );
        }
        for (const [canonical, legacy, arity] of [
            ["pauseLivePlayback", "liveStop", 0],
            ["replayFromLiveOffset", "timeShift", 1],
            ["showPlaybackSeekDialog", "shiftArchiveSelect", 1],
        ]) {
            const original = w[legacy];
            assert.equal(typeof original, "function");
            assert.equal(w[canonical], original, profile + ": " + canonical);
            assert.equal(
                original.name,
                legacy,
                profile + ": retained callback name"
            );
            assert.equal(
                original.length,
                arity,
                profile + ": retained callback arity"
            );
            try {
                const providerOverride = function () {};
                w[legacy] = providerOverride;
                assert.equal(
                    w[canonical],
                    providerOverride,
                    profile + ": canonical alias observes provider replacement"
                );
                const canonicalOverride = function () {};
                w[canonical] = canonicalOverride;
                assert.equal(
                    vm.runInContext(legacy, w),
                    canonicalOverride,
                    profile +
                        ": canonical assignment updates the bare legacy binding"
                );
            } finally {
                w[legacy] = original;
            }
            assert.equal(w[canonical], original);
        }
        const originalProvider = w.getChannelsArray;
        vm.runInContext(
            "function getChanelsArray() { return 'provider override'; }",
            w
        );
        assert.equal(w.getChannelsArray(), "provider override");
        w.getChannelsArray = originalProvider;
        assert.equal(w.getChanelsArray, originalProvider);
        const originalChannels = w.channels;
        const replacementChannels = { 123: { name: "Alias fixture" } };
        w.chanels = replacementChannels;
        assert.equal(w.channels, replacementChannels);
        w.channels = originalChannels;
        assert.equal(w.chanels, originalChannels);
        for (const name of [
            "MobileNativeMedia",
            "DashExoPlayer",
            "M3UProxy",
            "StalkerPortal",
        ]) {
            assert.equal(
                typeof w[name],
                "object",
                profile + ": missing native bridge " + name
            );
        }
        vm.runInContext(
            `
            if (typeof Number.isFinite !== "function" || !Number.isFinite(2) || Number.isFinite("2")) throw Error("Number polyfills");
            if (Object.assign({}, { x: 1 }).x !== 1 || !"abc".includes("b")) throw Error("Object/String polyfills");
            if ([4, 5].findIndex(function (n) { return n === 5; }) !== 1) throw Error("Array polyfill");
        `,
            w
        );
        // Exercise the live entrypoint through the replaceable device predicate.
        // The predicate must remain bound to the replaceable classic device ABI.
        const originalIsPlaying = w.stbIsPlaying;
        const originalPauseLive = w.__ottClassicArchive.pauseLive;
        let pausedLive = 0;
        w.__ottClassicArchive.pauseLive = () => pausedLive++;
        w.stbIsPlaying = () => false;
        w.liveStop();
        assert.equal(pausedLive, 0, "Stopped device must not pause live");
        w.stbIsPlaying = () => true;
        w.liveStop();
        assert.equal(
            pausedLive,
            1,
            "Actual bundle uses the current device predicate"
        );
        w.stbIsPlaying = originalIsPlaying;
        w.__ottClassicArchive.pauseLive = originalPauseLive;
        if (profile === "legacy") {
            assert.equal(
                typeof w.Promise,
                "function",
                "shared bootstrap supplies Promise before generic STB startup"
            );
        } else {
            const dash = await w.DashExoPlayer.isDashSupported();
            const media = await w.MobileNativeMedia.getVolume();
            if (profile === "capacitor-native") {
                assert.equal(
                    w.MobileNativeMedia,
                    w.Capacitor.Plugins.MobileNativeMedia
                );
                assert.equal(
                    w.DashExoPlayer,
                    w.Capacitor.Plugins.DashExoPlayer
                );
                assert.equal(dash.ok, true);
                assert.equal(media.volume, 37);
            } else {
                assert.equal(dash.ok, false);
                assert.equal(dash.unsupported, true);
                assert.equal(media.ok, false);
                assert.equal(media.unsupported, true);
            }
        }
        console.log(
            "OK: actual classic bundle " +
                profile +
                " profile, globals and native bridges"
        );
    }
}
main().catch((error) => {
    console.error(error.stack || error.message);
    if (error.cause)
        console.error(
            String(error.cause.stack).split("\n").slice(-8).join("\n")
        );
    process.exitCode = 1;
});
