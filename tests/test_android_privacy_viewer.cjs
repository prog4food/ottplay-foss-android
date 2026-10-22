/* Real viewer, jQuery and CPD functions; only the bundled-file I/O boundary is faked. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { localizationRuntime } = require("./helpers/localization-runtime.cjs");
const path = require("node:path");
const ts = require("typescript");
const acorn = require("acorn");
const { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function extract(file, names) {
    const parsed = ts.createSourceFile(
        file,
        read(file),
        ts.ScriptTarget.Latest,
        true
    );
    const found = parsed.statements.filter(
        (node) =>
            ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
    );
    assert.equal(found.length, names.length, "production functions: " + file);
    const code = ts.transpileModule(
        found
            .map((node) => node.getText(parsed).replace(/^export\s+/, ""))
            .join("\n"),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    acorn.parse(code, { ecmaVersion: 5 });
    return code;
}
const viewer = extract("src/index.ts", [
    "privacyPolicy",
    "pluginInfo",
    "interfaceCredits",
]);
const localization = localizationRuntime();
const cpd = extract("src/ui/index.ts", [
    "saveListPanelState",
    "restoreListPanelState",
]);
const documentText = read("docs/privacy-policy.md");
const parentHtml = ["First Run Setup", "Choose an action", "Parent footer"];

function fixture({
    url = "https://localhost/index.html",
    host = "https://localhost",
} = {}) {
    const dom = new JSDOM(
        '<div id="listCaption">First Run Setup</div><div id="listDetail">Choose an action</div><div id="listPodval">Parent footer</div><div id="listAbout" style="display:none"></div>',
        {
            runScripts: "dangerously",
            url,
        }
    );
    const w = dom.window;
    require("./helpers/screen-runtime.cjs")(w);
    w.eval(read("js/jquery-1.11.1.min.js"));
    const requests = [];
    const previousHandler = () => false;
    Object.assign(w, {
        _: (text, ...args) =>
            text.replace(/%(\d+)/g, (_match, index) => args[Number(index) - 1]),
        aboutKeyHandler: previousHandler,
        host,
        keys: { DOWN: 40, ENTER: 13, EXIT: 27, RETURN: 8, UP: 38 },
        listCaptionElement: w.document.getElementById("listCaption"),
        listDetailElement: w.document.getElementById("listDetail"),
        listFooterElement: w.document.getElementById("listPodval"),
        ui_state: {},
    });
    // Fail any accidental external/network request. Both success and failure
    // retain actual jQuery response conversion and callback dispatch semantics.
    w.$.ajaxTransport("+*", function (options) {
        const destination = new URL(options.url, w.location.href);
        assert.equal(destination.protocol, w.location.protocol);
        assert.equal(destination.host, w.location.host);
        assert.equal(destination.pathname, "/privacy-policy.txt");
        assert.equal(options.type, "GET");
        assert.equal(options.dataTypes[0], "text");
        return {
            abort() {},
            send(_headers, complete) {
                requests.push({ complete, url: destination.href });
            },
        };
    });
    w.eval(cpd + viewer);
    const panel = w.document.getElementById("listAbout");
    return {
        close: () => w.close(),
        content: () => panel.querySelector("pre"),
        fail(index = 0) {
            requests[index].complete(
                404,
                "Not Found",
                { text: "missing asset" },
                "Content-Type: text/plain\r\n"
            );
        },
        panel,
        parent: () => [
            w.listCaptionElement.innerHTML,
            w.listDetailElement.innerHTML,
            w.listFooterElement.innerHTML,
        ],
        previousHandler,
        requests,
        succeed(index = 0, text = documentText, contentType = "text/plain") {
            requests[index].complete(
                200,
                "OK",
                { text },
                "Content-Type: " + contentType + "\r\n"
            );
        },
        w,
    };
}
let cases = 0;
function test(name, run) {
    const f = fixture();
    try {
        run(f);
        cases++;
        console.log("PASS Android privacy viewer: " + name);
    } finally {
        f.close();
    }
}

test("first open loads the bundled policy text entirely through the local asset route", (f) => {
    f.w.privacyPolicy();
    assert.notEqual(f.panel.style.display, "none");
    assert.equal(f.content().textContent, "Loading...");
    assert.deepEqual(f.parent(), ["", "", ""]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, "https://localhost/privacy-policy.txt");
    f.succeed();
    assert.equal(f.content().textContent, documentText);
    assert.equal(f.content().style.whiteSpace, "pre-wrap");
    assert.equal(f.content().style.overflow, "auto");
});

test("document and script-looking error content stay literal, with no HTML execution", (f) => {
    f.w.privacyPolicy();
    const unsafe =
        '<script>window.privacyExecuted=true</script><img src=x onerror="window.privacyExecuted=true"> & plain text';
    // Even a mislabelled local response must remain text, not script inference.
    f.succeed(0, unsafe, "text/javascript");
    assert.equal(f.content().textContent, unsafe);
    assert.equal(f.content().querySelector("script,img"), null);
    assert.equal(f.w.privacyExecuted, undefined);
});

test("missing bundled file shows a local fallback without external retry", (f) => {
    f.w.privacyPolicy();
    f.fail();
    assert.match(f.content().textContent, /Privacy policy unavailable/);
    assert.match(f.content().textContent, /alvit\.work@gmail\.com/);
    assert.equal(f.requests.length, 1);
});

test("About labels and a missing privacy file follow the selected Russian language", (f) => {
    f.w.eval(localization + read("locales/russian.js"));
    f.w.PLAYER_VERSION = "1.2.3";
    f.w.version = "<br/>Version: 1.2.3";
    f.w.client_can_https = true;
    f.w.pluginInfo();
    assert.match(f.panel.textContent, /Версия: 1\.2\.3/);
    assert.match(f.panel.textContent, /Поддержка HTTPS: Да/);
    assert.match(
        f.panel.textContent,
        /Сервер OTT \/ приложения: https:\/\/localhost/
    );
    f.w.client_can_https = false;
    f.w.pluginInfo();
    assert.match(f.panel.textContent, /Поддержка HTTPS: Нет/);
    f.w.privacyPolicy();
    f.fail();
    assert.equal(
        f.content().textContent,
        "Политика конфиденциальности недоступна. Контакт: alvit.work@gmail.com"
    );
    assert.equal(f.requests.length, 1);
});

test("credits navigation follows the language while the attributed history stays marked as English", (f) => {
    const template = new JSDOM(read("index.html"));
    f.w.document.body.insertAdjacentHTML(
        "beforeend",
        template.window.document.getElementById("interfaceCreditsSource")
            .outerHTML
    );
    template.window.close();
    f.w.eval(localization + read("locales/russian.js"));
    f.w.renderButtonHint = (_key, _icon, text) => f.w._(text);
    f.w.strRETURN = "Back";
    f.w.interfaceCredits();
    assert.equal(
        f.panel.querySelector(".credits-title").textContent,
        "Авторы интерфейса"
    );
    assert.equal(
        f.panel.querySelector(".credits-navigation").textContent,
        "Прокрутка — вверх и вниз. Назад — закрыть."
    );
    assert.equal(
        f.panel.querySelector(".credits-language").textContent,
        "Оригинальный текст: Английский"
    );
    assert.equal(
        f.panel.querySelector(".credits-history").textContent,
        "Полная история, источники и условия лицензий"
    );
    assert.match(
        f.panel.querySelector('[lang="en"]').textContent,
        /The PLi-HD theme adapts/
    );
    f.w.aboutKeyHandler(f.w.keys.RETURN);
    f.w.eval(read("locales/english.js"));
    f.w.interfaceCredits();
    assert.equal(
        f.panel.querySelector(".credits-navigation").textContent,
        "Use Up / Down to scroll. Back to close."
    );
});

for (const key of ["RETURN", "EXIT", "ENTER"]) {
    test(
        key +
            " closes and restores actual parent CPD before invoking first-run callback once",
        (f) => {
            let returned = 0;
            f.w.privacyPolicy(() => {
                returned++;
                assert.deepEqual(f.parent(), parentHtml);
                assert.equal(f.panel.style.display, "none");
            });
            const handler = f.w.aboutKeyHandler;
            assert.equal(handler(f.w.keys[key]), true);
            assert.equal(returned, 1);
            assert.equal(f.panel.childElementCount, 0);
            assert.equal(f.w.aboutKeyHandler, f.previousHandler);
            handler(f.w.keys[key]);
            assert.equal(returned, 1, "already closed callback is idempotent");
        }
    );
}

test("visible Back button restores Info caller and stops bubbling", (f) => {
    let bubbles = 0;
    f.w.document.body.addEventListener("click", () => bubbles++);
    f.w.privacyPolicy();
    f.succeed();
    const back = f.panel.querySelector("button");
    assert.equal(back.textContent, "Back");
    back.click();
    assert.deepEqual(f.parent(), parentHtml);
    assert.equal(f.w.aboutKeyHandler, f.previousHandler);
    assert.equal(f.panel.style.display, "none");
    assert.equal(bubbles, 0);
});

test("UP/DOWN scroll the text while preserving the active overlay and parent", (f) => {
    f.w.privacyPolicy();
    f.succeed();
    const content = f.content();
    assert.equal(f.w.aboutKeyHandler(f.w.keys.DOWN), true);
    assert.equal(content.scrollTop, 100);
    f.w.aboutKeyHandler(f.w.keys.DOWN);
    assert.equal(content.scrollTop, 200);
    f.w.aboutKeyHandler(f.w.keys.UP);
    assert.equal(content.scrollTop, 100);
    f.w.aboutKeyHandler(f.w.keys.UP);
    assert.equal(content.scrollTop, 0);
    assert.notEqual(f.panel.style.display, "none");
    assert.deepEqual(f.parent(), ["", "", ""]);
});

for (const outcome of ["succeed", "fail"]) {
    test(
        "late " +
            outcome +
            " after close cannot reopen or mutate a newer viewer",
        (f) => {
            f.w.privacyPolicy();
            const retiredContent = f.content();
            f.w.aboutKeyHandler(f.w.keys.RETURN);
            f[outcome]();
            assert.equal(f.panel.style.display, "none");
            assert.equal(f.panel.childElementCount, 0);
            assert.equal(retiredContent.textContent, "Loading...");
            assert.deepEqual(f.parent(), parentHtml);
            f.w.privacyPolicy();
            f.succeed(1, "Current document");
            assert.equal(f.content().textContent, "Current document");
            f.w.aboutKeyHandler(f.w.keys.RETURN);
            assert.deepEqual(f.parent(), parentHtml);
        }
    );
}

test("an earlier request completed after reopen cannot replace the new document", (f) => {
    f.w.privacyPolicy();
    f.w.aboutKeyHandler(f.w.keys.RETURN);
    f.w.privacyPolicy();
    f.succeed(1, "New document");
    f.succeed(0, "Old document");
    assert.equal(f.content().textContent, "New document");
    f.panel.querySelector("button").click();
    assert.deepEqual(f.parent(), parentHtml);
});

console.log(
    "Android privacy viewer: " +
        cases +
        " scenarios passed; no network or WebView claim"
);
