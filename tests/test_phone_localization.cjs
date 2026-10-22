const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const {
    readDictionary,
    languageAssets,
} = require("../scripts/localization-catalog.cjs");
const {
    phoneKeys,
    PHONE_HTML,
    stageHostedSwop,
} = require("../scripts/hosted-swop.cjs");
function compile(file, module = ts.ModuleKind.CommonJS) {
    return ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
        compilerOptions: { module, target: ts.ScriptTarget.ES5 },
    }).outputText;
}
function load(file, context = {}) {
    context.exports = {};
    vm.runInNewContext(compile(file), context);
    return context.exports;
}
const assets = load("src/localization/assets.ts");
async function main() {
    const dom = new JSDOM(PHONE_HTML, {
        url: "https://phone.invalid/swop-input/",
    });
    const w = dom.window,
        pending = [];
    const files = Object.fromEntries(
        Object.keys(languageAssets).map((code) => [
            code,
            "/swop-input/locales/" + code + ".json",
        ])
    );
    w.XMLHttpRequest = class {
        open(method, url) {
            this.method = method;
            this.url = url;
        }
        send() {
            pending.push(this);
        }
    };
    const api = load("src/swop/phone-localization.ts", {
        __OTT_PHONE_LOCALES__: files,
        require: () => assets,
    });
    let locale = api.createPhoneLocalization(w);
    const status = w.document.getElementById("status");
    function respond(request, values, status = 200) {
        request.status = status;
        request.responseText =
            typeof values === "string" ? values : JSON.stringify(values);
        request.onload();
    }
    const ru = readDictionary(path.join(root, languageAssets._rus));
    const ar = readDictionary(path.join(root, languageAssets._ara));
    locale.label(status, "Cancel");
    const first = locale.setLanguage("_ara"),
        second = locale.setLanguage("_rus");
    assert.equal(pending[1].method, "GET");
    assert.equal(pending[1].timeout, 5000);
    respond(pending[1], { Cancel: ru.Cancel });
    assert.equal(await second, true);
    assert.equal(status.textContent, ru.Cancel);
    respond(pending[0], { Cancel: ar.Cancel });
    assert.equal(await first, false);
    assert.equal(
        w.document.documentElement.lang,
        "ru",
        "late browser language cannot override the paired TV"
    );
    const beforeCached = pending.length;
    await locale.setLanguage("_ara");
    assert.equal(
        pending.length,
        beforeCached,
        "a stale response is cached without publishing"
    );
    assert.equal(w.document.documentElement.lang, "ar");
    assert.equal(w.document.documentElement.dir, "rtl");
    assert.equal(w.document.getElementById("link").dir, "ltr");
    assert.equal(w.document.getElementById("value").dir, "auto");
    assert.equal(status.textContent, ar.Cancel);
    locale = api.createPhoneLocalization(w);
    const initial = locale.setLanguage("_ara");
    respond(pending.at(-1), { Cancel: ar.Cancel });
    await initial;
    for (const bad of ["broken{", [], { Cancel: 1 }, { Cancel: "" }, null]) {
        const loading = locale.setLanguage("_rus");
        respond(pending.at(-1), bad);
        assert.equal(await loading, false);
        assert.equal(status.textContent, ar.Cancel);
        assert.equal(w.document.documentElement.dir, "rtl");
    }
    const timeout = locale.setLanguage("_rus"),
        request = pending.at(-1);
    request.ontimeout();
    assert.equal(await timeout, false);
    respond(request, { Cancel: ru.Cancel });
    assert.equal(
        status.textContent,
        ar.Cancel,
        "late load after timeout has no effect"
    );
    const unknown = locale.setLanguage("__proto__");
    assert.equal(pending.at(-1).url, files._eng);
    respond(pending.at(-1), { Cancel: "Cancel" });
    await unknown;
    Object.defineProperty(w.navigator, "languages", {
        configurable: true,
        value: ["xx-ZZ", "ru-RU"],
    });
    assert.equal(locale.browserLanguage(), "_rus");
    const textOnly = locale.setLanguage("_rus");
    respond(pending.at(-1), { Cancel: '<img src=x onerror="alert(1)">' });
    await textOnly;
    assert.equal(
        status.querySelector("img"),
        null,
        "translations are rendered as text, never page markup"
    );
    for (const order of ["browser-first", "tv-first"]) {
        const race = api.createPhoneLocalization(w);
        const offset = pending.length;
        const browser = race.setLanguage("_rus");
        const tv = race.setLanguage("_ara", "_rus");
        if (order === "browser-first") {
            respond(pending[offset], { Cancel: ru.Cancel });
            await browser;
            pending[offset + 1].onerror();
        } else {
            pending[offset + 1].onerror();
            await Promise.resolve();
            await Promise.resolve();
            respond(pending[offset], { Cancel: ru.Cancel });
        }
        assert.equal(await tv, false);
        await browser;
        assert.equal(
            pending.length,
            offset + 2,
            "reuse browser request: " + order
        );
        assert.equal(
            status.textContent,
            ru.Cancel,
            "browser fallback: " + order
        );
        assert.equal(w.document.documentElement.lang, "ru");
    }
    {
        const race = api.createPhoneLocalization(w);
        const offset = pending.length;
        const browser = race.setLanguage("_rus");
        const oldTV = race.setLanguage("_ara", "_rus");
        pending[offset + 1].onerror();
        await Promise.resolve();
        await Promise.resolve();
        const newTV = race.setLanguage("_eng", "_rus");
        respond(pending[offset + 2], { Cancel: "Cancel" });
        assert.equal(await newTV, true);
        respond(pending[offset], { Cancel: ru.Cancel });
        await Promise.all([browser, oldTV]);
        assert.equal(
            status.textContent,
            "Cancel",
            "old fallback cannot override new TV"
        );
        assert.equal(w.document.documentElement.lang, "en");
    }
    {
        const race = api.createPhoneLocalization(w);
        const browser = race.setLanguage("_rus");
        respond(pending.at(-1), { Cancel: ru.Cancel });
        await browser;
        let owner = true;
        const cancelledTV = race.setLanguage("_ara", "_rus", () => owner);
        owner = false;
        respond(pending.at(-1), { Cancel: ar.Cancel });
        assert.equal(await cancelledTV, false);
        assert.equal(
            status.textContent,
            ru.Cancel,
            "cancelled TV request cannot publish"
        );
        assert.equal(w.document.documentElement.lang, "ru");
    }
    // Legacy offers have no language field and can precede the browser catalog.
    for (const caption of ["", "Enter text", "<b>My playlist</b>"]) {
        const page = new JSDOM(PHONE_HTML, {
            runScripts: "outside-only",
            url: "https://phone.invalid/swop-input/#fixture",
        });
        const phone = page.window,
            requests = [];
        Object.defineProperty(phone.navigator, "languages", {
            value: ["ru-RU"],
        });
        phone.XMLHttpRequest = class {
            open() {}
            send() {
                requests.push(this);
            }
        };
        const core = {
            hereNowCryptoAvailable: () => true,
            hereNowOpen: async () => ({ caption, draft: "" }),
            hereNowReadPair: () => ({
                deadline: Date.now() + 60000,
                recordId: "fixture",
                secret: new Uint8Array(32),
            }),
            hereNowStore: () => ({ get: async () => ({ offer: "fixture" }) }),
            hereNowSwopConfig: () => ({ collection: "fixture" }),
            hereNowValidValue: () => true,
        };
        phone.require = (id) =>
            id === "./herenow"
                ? core
                : id === "./phone-localization"
                  ? api
                  : assets;
        phone.exports = {};
        try {
            phone.eval(compile("src/swop/herenow-phone.ts"));
            for (let i = 0; i < 10; i++) await Promise.resolve();
            const label = phone.document.getElementById("caption");
            assert.equal(phone.document.getElementById("entry").hidden, false);
            assert.equal(
                requests.length,
                1,
                "browser dictionary still pending"
            );
            respond(requests[0], ru);
            for (let i = 0; i < 10; i++) await Promise.resolve();
            assert.equal(phone.document.documentElement.lang, "ru");
            assert.equal(
                label.textContent,
                caption || ru["Enter text"],
                "late language translates only a generated caption"
            );
            assert.equal(label.querySelector("b"), null);
        } finally {
            phone.close();
        }
    }
    dom.window.close();
    console.log(
        "PASS phone localization: real RU/Arabic text, encrypted-offer language precedence, timeout/invalid/stale data, safe text and bidi fields"
    );
    if (process.argv.includes("--runtime-only")) return;
    const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), "ott-phone-localization-")
    );
    try {
        const build = path.join(tmp, "build"),
            out = path.join(tmp, "out");
        for (const file of [
            "src/localization/assets.ts",
            "src/swop/herenow.ts",
            "src/swop/phone-localization.ts",
            "src/swop/herenow-phone.ts",
        ]) {
            const target = path.join(
                build,
                file.replace(/^src\//, "").replace(/\.ts$/, ".js")
            );
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, compile(file, ts.ModuleKind.ES2015));
        }
        await stageHostedSwop(out, build);
        const keys = phoneKeys(
            PHONE_HTML,
            fs.readFileSync(
                path.join(root, "src/swop/herenow-phone.ts"),
                "utf8"
            )
        );
        const output = path.join(out, "swop-input/locales");
        const staged = fs.readdirSync(output);
        assert.equal(staged.length, 88);
        for (const [code, asset] of Object.entries(languageAssets)) {
            const filename = staged.find((name) =>
                name.startsWith(code.slice(1) + "-")
            );
            assert(filename, code);
            assert.match(filename, /^[a-z]{3}-[a-f0-9]{16}\.json$/);
            const translated = JSON.parse(
                fs.readFileSync(path.join(output, filename))
            );
            const catalog = readDictionary(path.join(root, asset));
            assert.deepEqual(Object.keys(translated).sort(), keys);
            for (const key of keys) assert.equal(translated[key], catalog[key]);
        }
        require("acorn").parse(
            fs.readFileSync(path.join(out, "swop-input/app.js"), "utf8"),
            { ecmaVersion: 5 }
        );
        assert(
            fs
                .readFileSync(path.join(out, "swop-input/app.js"), "utf8")
                .includes("/swop-input/locales/")
        );
        console.log(
            "PASS phone localization: all 88 immutable catalog subsets and ES5 deployable page"
        );
    } finally {
        fs.rmSync(tmp, { force: true, recursive: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
